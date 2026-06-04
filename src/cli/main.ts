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
import { loadRepoConfig } from "../core/planner/repoConfig.js";
import { resolveAppSource, ghDeploymentLookup } from "../harness/ui/appSource.js";
import { PlaywrightBrowserDriver } from "../harness/ui/browserDriver.js";
import { AgenticUiHarness } from "../harness/ui/agenticUiHarness.js";
import type { UiHarness } from "../harness/ui/uiHarness.js";
import { renderMarkdown, postPrComment } from "../core/reporting/reporter.js";
import { computeMetrics, renderMetricsMarkdown } from "../core/reporting/metrics.js";
import { buildStepSummary } from "./step.js";
import { runInit } from "./init.js";
import { runDoctor, renderDoctorReport } from "./doctor.js";
import {
  watchTick,
  ghListOpenPrs,
  ghListIssueComments,
  ghMergePr,
  type WatchDeps,
} from "./watch.js";

const USAGE = `verifyflow — evidence-backed delivery verification

Usage:
  vf run    --linear <KEY|url> --pr <url|owner/repo#N|#N> --level <functional|ui|journey> [options]
  vf step   --pr <url> [options]      Orchestrator-facing step (Symphony, IN-569): advisory-only,
                                      auto-resolves the Linear issue from the PR (body or branch),
                                      checks out + executes + posts the report comment, and prints
                                      a single machine-readable JSON line to stdout. Never blocks.
  vf report [--out <dir>] [--json]    Aggregate accumulated runs into quality-intelligence metrics.
  vf init [--dir <path>]              Scaffold a verifyflow.config.json (default: current directory).
  vf doctor                           Check that required tools (gh, claude, uv, LINEAR_API_KEY) are ready.
  vf watch  --repo <owner/repo> [--auto-merge] [--interval <s>] [--level <l>]
                                      Independent daemon: watch the repo's Crosscheck-approved PRs,
                                      verify delivery, and (with --auto-merge) squash-merge on accept.

Step-only options:
  --crosscheck-verdict <v>  Crosscheck verdict handed in by the caller (recorded, not gated on).
  --no-comment              Skip posting the PR comment (default for step: comment on).

Options:
  --linear <KEY|url>     Linear issue (PRIMARY source of acceptance criteria).
                         If omitted, VerifyFlow derives it from the PR body's Linear link.
  --pr <ref>             GitHub PR URL, owner/repo#N, or #N.
  --level <level>        functional | ui (AI-driven browser). journey not yet implemented.
  --base-url <url>       Base URL of the running app for ui-level browser checks. If omitted,
                         VerifyFlow tries to discover a deployment preview from the PR's checks.
  --ui-auth <file>       Playwright storageState JSON (cookies/localStorage) for an authenticated
                         ui session. Create with: playwright codegen --save-storage=auth.json
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
  --allow-no-ticket      Degraded mode when no Linear issue can be resolved: verify against
                         the PR's own description; verdict capped at manual_review_required.
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

  // For ui level: resolve a live app URL (explicit → preview → local) and build the AI-driven
  // browser harness. The browser is an optional dependency; without it we leave the harness
  // undefined so the pipeline blocks the criteria rather than false-passing them (IN-606).
  let resolvedBaseUrl = str(args["base-url"]);
  let uiHarnessFactory: ((artifactRoot: string) => UiHarness) | undefined;
  let appCleanup: (() => Promise<void>) | undefined;
  if (level === "ui" && !fixtures) {
    const prCtx = await github.loadPr(parsePrRef(pr));
    const repoConfig = await loadRepoConfig(workdir ? path.resolve(workdir) : undefined);
    const source = await resolveAppSource({
      explicitBaseUrl: str(args["base-url"]),
      pr: prCtx,
      repoConfig,
      workdir: workdir ? path.resolve(workdir) : undefined,
      deps: { lookupDeployments: ghDeploymentLookup() },
    });
    if (source.kind === "ready") {
      resolvedBaseUrl = source.baseUrl;
      appCleanup = source.cleanup;
      console.error(`[verifyflow] ui app source: ${source.source} → ${source.baseUrl}`);
    } else {
      console.error(`[verifyflow] ui: ${source.reason} — criteria will be environment-blocked.`);
    }

    const driver = new PlaywrightBrowserDriver();
    if (await driver.available()) {
      const auth = str(args["ui-auth"]);
      uiHarnessFactory = (artifactRoot) =>
        new AgenticUiHarness({ driver, llm, artifactsDir: artifactRoot, storageStatePath: auth });
    } else {
      console.error(
        "[verifyflow] ui: Playwright not installed — install with " +
          "`npm i -D playwright && npx playwright install chromium`. Criteria will be blocked.",
      );
    }
  }

  const request: RunRequest = {
    linearIssue: str(args.linear) ?? "",
    pullRequest: pr,
    level,
    policy,
    backend: str(args.backend),
    outputRoot,
    workdir: workdir ? path.resolve(workdir) : undefined,
    baseUrl: resolvedBaseUrl,
    sandbox: !args["no-sandbox"],
    crosscheckVerdict: str(args["crosscheck-verdict"]),
    allowNoTicket: !!args["allow-no-ticket"],
  };

  const deps: PipelineDeps = {
    linear,
    github,
    llm,
    memory: new MemoryStore(outputRoot),
    eventLog: new EventLog(outputRoot),
    uiHarnessFactory,
  };

  if (!request.workdir) {
    console.error(
      "[verifyflow] no --workdir/--checkout: skipping real execution (criteria will be blocked/not_evaluable).",
    );
  }

  let runResult;
  try {
    runResult = await runVerification(request, deps);
  } finally {
    if (appCleanup) await appCleanup();
  }
  const { report, runDir, reportPaths, signalPath } = runResult;

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

  if (args["linear-writeback"] && !fixtures && linear.addComment && report.issue.source !== "pr-degraded") {
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

/** `vf init [--dir <path>]` — scaffold a per-repo config (IN-611). */
async function cmdInit(args: Args): Promise<number> {
  const dir = str(args.dir) ? path.resolve(str(args.dir)!) : process.cwd();
  const res = await runInit(dir);
  if (res.created) {
    console.log(`created ${res.path}`);
    console.log("Edit it for your stack (setup / test / runPrefix), then run: vf run --help");
  } else {
    console.log(`${res.path} ${res.reason}`);
  }
  return 0;
}

/** `vf doctor` — check required tools/env are ready (IN-611). Exit non-zero if a required one is missing. */
async function cmdDoctor(): Promise<number> {
  const report = await runDoctor();
  console.log(renderDoctorReport(report));
  return report.ok ? 0 : 1;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * `vf watch` — independent delivery-gate daemon (IN-622). Polls the repo's open PRs; for each
 * Crosscheck-approved head not yet verified, runs verification (reusing the run executor) and,
 * with --auto-merge, squash-merges on a clean `accept`. Loops until interrupted.
 */
async function cmdWatch(args: Args): Promise<number> {
  const repo = str(args.repo);
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) {
    console.error("error: vf watch needs --repo <owner/repo>\n");
    return 2;
  }
  const intervalMs = Math.max(10, Number(str(args.interval) ?? "60")) * 1000;
  const autoMerge = !!args["auto-merge"];
  const level = str(args.level) ?? "functional";
  const seen = new Map<number, string>();

  const deps: WatchDeps = {
    listOpenPrs: ghListOpenPrs,
    listIssueComments: ghListIssueComments,
    verify: async (pr) => {
      const outcome = await executeRun({ pr: `${repo}#${pr.number}`, level, checkout: true, comment: true });
      if (typeof outcome === "number") return { verdict: "error", merged: false };
      const verdict = outcome.report.runVerdict;
      let merged = false;
      if (autoMerge && verdict === "accept") merged = await ghMergePr(repo, pr.number, pr.headSha);
      return { verdict, merged };
    },
  };

  console.error(
    `[verifyflow] vf watch on ${repo} — every ${intervalMs / 1000}s, auto-merge: ${autoMerge} (Ctrl-C to stop).`,
  );
  let stop = false;
  process.on("SIGINT", () => {
    stop = true;
    console.error("\n[verifyflow] stopping watch after the current tick…");
  });
  while (!stop) {
    try {
      const acted = await watchTick(repo, deps, seen);
      for (const a of acted) {
        console.error(
          `[verifyflow] PR #${a.pr}@${a.headSha.slice(0, 8)}: verdict=${a.verdict} merged=${a.merged}` +
            (a.error ? ` error=${a.error}` : ""),
        );
      }
    } catch (err) {
      console.error(`[verifyflow] watch tick error: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (stop) break;
    await sleep(intervalMs);
  }
  return 0;
}

async function main(): Promise<number> {
  const { cmd, args } = parseArgs(process.argv.slice(2));
  // `help`, `--help`/`-h` as the first token, or any `--help`/`-h` flag → usage (exit 0).
  // An empty invocation still prints usage but exits 2 (nothing to do).
  if (args.help || cmd === "" || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return cmd === "" ? 2 : 0;
  }
  if (cmd === "run") return cmdRun(args);
  if (cmd === "step") return cmdStep(args);
  if (cmd === "report") return cmdReport(args);
  if (cmd === "init") return cmdInit(args);
  if (cmd === "doctor") return cmdDoctor();
  if (cmd === "watch") return cmdWatch(args);
  console.error(`error: unknown command "${cmd}"\n`);
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
