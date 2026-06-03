#!/usr/bin/env node
import path from "node:path";
import { runVerification, type PipelineDeps } from "../core/pipeline.js";
import type { Level, Policy, RunRequest } from "../types.js";
import { GhCliClient, FixtureGithubClient, parsePrRef } from "../core/context/github.js";
import { FixtureLinearClient, LinearApiClient } from "../core/context/linear.js";
import { ClaudeCliClient } from "../backends/claudeCli.js";
import { FallbackLlm } from "../backends/fallbackLlm.js";
import type { LlmClient } from "../backends/llm.js";
import { MemoryStore } from "../memory/store.js";
import { EventLog } from "../memory/eventLog.js";
import { ensurePrCheckout } from "../harness/checkout.js";
import { renderMarkdown, postPrComment } from "../core/reporting/reporter.js";
import { computeMetrics, renderMetricsMarkdown } from "../core/reporting/metrics.js";

const USAGE = `verifyflow — evidence-backed delivery verification

Usage:
  vf run    --linear <KEY|url> --pr <url|owner/repo#N|#N> --level <functional|ui|journey> [options]
  vf report [--out <dir>] [--json]    Aggregate accumulated runs into quality-intelligence metrics.

Options:
  --linear <KEY|url>     Linear issue (PRIMARY source of acceptance criteria).
                         If omitted, VerifyFlow derives it from the PR body's Linear link.
  --pr <ref>             GitHub PR URL, owner/repo#N, or #N.
  --level <level>        functional (only supported level today), ui, journey.
  --policy <p>           advisory (default) | merge_gate.
  --backend <name>       Label recorded in the report (default: the LLM backend name).
  --model <m>            Model for the claude CLI backend.
  --out <dir>            Output root for reports/artifacts/memory (default: ./.verifyflow).
  --workdir <dir>        Existing checkout of the target repo to execute against.
  --checkout             Clone the repo and check out the PR head (live execution).
  --fixtures <dir>       Offline mode: read issue.json / pr.json from <dir>.
  --comment              Post the markdown report as a PR comment (live only).
  -h, --help             Show this help.

Auth model: VerifyFlow stores no secrets. It uses the authorized CLIs you have installed —
  gh (GitHub), claude (LLM), git/uv (execution). Linear: set LINEAR_API_KEY or use --fixtures.
`;

interface Args {
  [k: string]: string | boolean | undefined;
}

function parseArgs(argv: string[]): { cmd: string; args: Args } {
  const cmd = argv[0] ?? "";
  const args: Args = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") args.help = true;
    else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) args[key] = true;
      else {
        args[key] = next;
        i++;
      }
    }
  }
  return { cmd, args };
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

async function buildLlm(args: Args): Promise<LlmClient> {
  const claude = new ClaudeCliClient({ model: str(args.model) });
  if (await claude.available()) return claude;
  console.error("[verifyflow] claude CLI not found — using deterministic fallback (rules only).");
  return new FallbackLlm();
}

async function cmdRun(args: Args): Promise<number> {
  const pr = str(args.pr);
  const level = (str(args.level) ?? "functional") as Level;
  if (!pr) {
    console.error("error: --pr is required\n");
    console.error(USAGE);
    return 2;
  }
  if (level !== "functional") {
    console.error(`error: level "${level}" is not implemented yet (only "functional").`);
    return 2;
  }

  const outputRoot = path.resolve(str(args.out) ?? ".verifyflow");
  const policy = (str(args.policy) ?? "advisory") as Policy;
  const fixtures = str(args.fixtures);

  // Build context clients.
  let linear, github;
  if (fixtures) {
    const dir = path.resolve(fixtures);
    linear = new FixtureLinearClient(dir);
    github = new FixtureGithubClient(dir);
  } else {
    github = new GhCliClient();
    const key = process.env.LINEAR_API_KEY;
    if (!key) {
      console.error(
        "error: live mode needs LINEAR_API_KEY (Linear is the criteria source). " +
          "Use --fixtures <dir> for offline runs, or capture the issue via the Linear connector.",
      );
      return 2;
    }
    linear = new LinearApiClient(key);
  }

  const llm = await buildLlm(args);

  // Resolve a working directory for real execution.
  let workdir = str(args.workdir);
  if (!workdir && args.checkout && !fixtures) {
    const ref = parsePrRef(pr);
    const ghMeta = await github.loadPr(ref);
    console.error(`[verifyflow] checking out ${ref.repo}#${ref.number}@${ghMeta.headSha.slice(0, 12)} ...`);
    const co = await ensurePrCheckout({
      repo: ref.repo,
      prNumber: ref.number,
      headSha: ghMeta.headSha,
      baseDir: outputRoot,
    });
    workdir = co.workdir;
    co.logs.forEach((l) => console.error("  " + l));
  }

  const request: RunRequest = {
    linearIssue: str(args.linear) ?? "",
    pullRequest: pr,
    level,
    policy,
    backend: str(args.backend),
    outputRoot,
    workdir: workdir ? path.resolve(workdir) : undefined,
  };

  const deps: PipelineDeps = {
    linear,
    github,
    llm,
    memory: new MemoryStore(outputRoot),
    eventLog: new EventLog(outputRoot),
  };

  if (!request.workdir) {
    console.error(
      "[verifyflow] no --workdir/--checkout: skipping real execution (criteria will be blocked/not_evaluable).",
    );
  }

  const { report, reportPaths } = await runVerification(request, deps);

  console.log(renderMarkdown(report));
  console.error(`\n[verifyflow] reports: ${reportPaths.markdownPath} | ${reportPaths.jsonPath}`);

  if (args.comment && !fixtures) {
    const ok = await postPrComment(report, renderMarkdown(report));
    console.error(ok ? "[verifyflow] posted PR comment." : "[verifyflow] failed to post PR comment.");
  }

  if (report.gate?.blocked) return 1;
  return 0;
}

async function cmdReport(args: Args): Promise<number> {
  const outputRoot = path.resolve(str(args.out) ?? ".verifyflow");
  const events = await new EventLog(outputRoot).readAll();
  if (events.length === 0) {
    console.error(`[verifyflow] no events found under ${outputRoot} — run \`vf run\` first.`);
    return 0;
  }
  const metrics = computeMetrics(events);
  console.log(args.json ? JSON.stringify(metrics, null, 2) : renderMetricsMarkdown(metrics));
  return 0;
}

async function main(): Promise<number> {
  const { cmd, args } = parseArgs(process.argv.slice(2));
  if (args.help || cmd === "" || cmd === "help") {
    console.log(USAGE);
    return cmd === "" ? 2 : 0;
  }
  if (cmd === "run") return cmdRun(args);
  if (cmd === "report") return cmdReport(args);
  console.error(`unknown command: ${cmd}\n`);
  console.log(USAGE);
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("[verifyflow] fatal:", err instanceof Error ? err.stack : err);
    process.exit(1);
  },
);
