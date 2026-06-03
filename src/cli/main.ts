#!/usr/bin/env node
import path from "node:path";
import { runVerification, type PipelineDeps } from "../core/pipeline.js";
import type { Level, Policy, RunRequest } from "../types.js";
import { GhCliClient, FixtureGithubClient, parsePrRef } from "../core/context/github.js";
import { FixtureLinearClient, LinearApiClient, type LinearClient } from "../core/context/linear.js";
import { ClaudeCliClient } from "../backends/claudeCli.js";
import { FallbackLlm } from "../backends/fallbackLlm.js";
import type { LlmClient } from "../backends/llm.js";
import { MemoryStore } from "../memory/store.js";
import { EventLog } from "../memory/eventLog.js";
import { ensurePrCheckout } from "../harness/checkout.js";
import { renderMarkdown, postPrComment } from "../core/reporting/reporter.js";
import { computeMetrics, renderMetricsMarkdown } from "../core/reporting/metrics.js";
import { buildStepSummary } from "./step.js";

const USAGE = `verifyflow — evidence-backed delivery verification

Usage:
  vf run    --linear <KEY|url> --pr <url|owner/repo#N|#N> --level <functional|ui|journey> [options]
  vf step   --pr <url> [options]      Orchestrator-facing step (Symphony, IN-569): advisory-only,
                                      auto-resolves the Linear issue from the PR (body or branch),
                                      checks out + executes + posts the report comment, and prints
                                      a single machine-readable JSON line to stdout. Never blocks.
  vf report [--out <dir>] [--json]    Aggregate accumulated runs into quality-intelligence metrics.

Step-only options:
  --crosscheck-verdict <v>  Crosscheck verdict handed in by the caller (recorded, not gated on).
  --no-comment              Skip posting the PR comment (default for step: comment on).

Options:
  --linear <KEY|url>     Linear issue (PRIMARY source of acceptance criteria).
                         If omitted, VerifyFlow derives it from the PR body's Linear link.
  --pr <ref>             GitHub PR URL, owner/repo#N, or #N.
  --level <level>        functional | ui (browser-driven). journey not yet implemented.
  --base-url <url>       Base URL of the running app for ui-level browser checks.
  --policy <p>           advisory (default, never blocks) | merge_gate (blocks on needs_fix)
                         | strict (also blocks on manual_review_required / accept_with_risks).
  --backend <name>       Label recorded in the report (default: the LLM backend name).
  --model <m>            Model for the claude CLI backend.
  --out <dir>            Output root for reports/artifacts/memory (default: ./.verifyflow).
  --workdir <dir>        Existing checkout of the target repo to execute against.
  --checkout             Clone the repo and check out the PR head (live execution).
  --fixtures <dir>       Offline mode: read issue.json / pr.json from <dir>.
  --comment              Post the markdown report as a PR comment (live only; updates in place).
  --linear-writeback     Post the delivery verdict back to the linked Linear issue (live only).
  --no-sandbox           Pass host env (incl. secrets) to probes. Default: strip secrets.
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

interface RunOutcome {
  report: Awaited<ReturnType<typeof runVerification>>["report"];
  runDir: string;
  reportPaths: Awaited<ReturnType<typeof runVerification>>["reportPaths"];
  signalPath?: string;
  prCommentPosted: boolean;
}

/**
 * Shared run executor behind `vf run` and `vf step`: validates args, builds clients,
 * checks out the PR head when asked, runs the verification pipeline, and performs the
 * PR-comment / Linear write-backs. Writes only to stderr — stdout is owned by the caller
 * (markdown for `run`, a single JSON line for `step`).
 */
async function executeRun(args: Args): Promise<RunOutcome | number> {
  const pr = str(args.pr);
  const level = (str(args.level) ?? "functional") as Level;
  if (!pr) {
    console.error("error: --pr is required\n");
    console.error(USAGE);
    return 2;
  }
  if (level !== "functional" && level !== "ui") {
    console.error(`error: level "${level}" is not implemented yet (functional, ui).`);
    return 2;
  }

  const outputRoot = path.resolve(str(args.out) ?? ".verifyflow");
  const policy = (str(args.policy) ?? "advisory") as Policy;
  if (!["advisory", "merge_gate", "strict"].includes(policy)) {
    console.error(`error: unknown --policy "${policy}" (expected advisory | merge_gate | strict).`);
    return 2;
  }
  const fixtures = str(args.fixtures);

  // Build context clients.
  let linear: LinearClient;
  let github;
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
    baseUrl: str(args["base-url"]),
    sandbox: !args["no-sandbox"],
    crosscheckVerdict: str(args["crosscheck-verdict"]),
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

  const { report, runDir, reportPaths, signalPath } = await runVerification(request, deps);

  console.error(`\n[verifyflow] reports: ${reportPaths.markdownPath} | ${reportPaths.jsonPath}`);
  if (signalPath) {
    console.error(`[verifyflow] bounce-back signal (feed to the coding agent): ${signalPath}`);
  }

  let prCommentPosted = false;
  if (args.comment && !fixtures) {
    prCommentPosted = await postPrComment(report, renderMarkdown(report));
    console.error(
      prCommentPosted ? "[verifyflow] posted/updated PR comment." : "[verifyflow] failed to post PR comment.",
    );
  }

  if (args["linear-writeback"] && !fixtures && linear.addComment) {
    const ok = await linear.addComment(
      report.issue.key,
      `VerifyFlow delivery verdict: **${report.runVerdict}**. ${report.summary}`,
    );
    console.error(ok ? "[verifyflow] posted Linear comment." : "[verifyflow] failed to post Linear comment.");
  }

  return { report, runDir, reportPaths, signalPath, prCommentPosted };
}

async function cmdRun(args: Args): Promise<number> {
  const outcome = await executeRun(args);
  if (typeof outcome === "number") return outcome;

  console.log(renderMarkdown(outcome.report));

  if (outcome.report.gate?.blocked) return 1;
  return 0;
}

/**
 * Orchestrator-facing step entrypoint (IN-569): Symphony invokes this after Crosscheck.
 * Advisory-only — exit 0 whenever verification completed, regardless of the verdict;
 * non-zero only on operational failure. Prints exactly one JSON line on stdout.
 */
async function cmdStep(args: Args): Promise<number> {
  if (args.policy && str(args.policy) !== "advisory") {
    console.error("error: vf step is advisory-only (phase 1) — --policy cannot be changed. Use vf run for gating.");
    return 2;
  }
  args.policy = "advisory";

  const fixtures = str(args.fixtures);
  // Step defaults: live execution against the PR head, report posted back to the PR.
  if (!args.workdir && !fixtures) args.checkout = true;
  if (!args["no-comment"] && !fixtures) args.comment = true;

  const outcome = await executeRun(args);
  if (typeof outcome === "number") return outcome;

  const summary = buildStepSummary({
    report: outcome.report,
    runDir: outcome.runDir,
    reportJsonPath: outcome.reportPaths.jsonPath,
    reportMarkdownPath: outcome.reportPaths.markdownPath,
    signalPath: outcome.signalPath,
    prCommentPosted: outcome.prCommentPosted,
  });
  console.log(JSON.stringify(summary));
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
  if (cmd === "step") return cmdStep(args);
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
