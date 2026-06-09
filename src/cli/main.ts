#!/usr/bin/env node
import path from "node:path";
import os from "node:os";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { runVerification, planRun, type PipelineDeps, type PlanPreview } from "../core/pipeline.js";
import type { Level, Policy, RunReport, RunRequest } from "../types.js";
import { GhCliClient, FixtureGithubClient, parsePrRef } from "../core/context/github.js";
import { FixtureLinearClient, LinearApiClient, type LinearClient } from "../core/context/linear.js";
import { resolveLinearApiKey } from "./credentials.js";
import { ClaudeCliClient } from "../backends/claudeCli.js";
import { FallbackLlm } from "../backends/fallbackLlm.js";
import type { LlmClient } from "../backends/llm.js";
import { MemoryStore } from "../memory/store.js";
import { EventLog } from "../memory/eventLog.js";
import { ensurePrCheckout } from "../harness/checkout.js";
import { inferPrRef, inGitRepo } from "./inferContext.js";
import { loadRepoConfig } from "../core/planner/repoConfig.js";
import { resolveAppSource, ghDeploymentLookup } from "../harness/ui/appSource.js";
import { PlaywrightBrowserDriver } from "../harness/ui/browserDriver.js";
import { AgenticUiHarness } from "../harness/ui/agenticUiHarness.js";
import type { UiHarness } from "../harness/ui/uiHarness.js";
import { AgenticJourneyHarness, type CommandOutcome } from "../harness/journey/agenticJourneyHarness.js";
import type { JourneyHarness } from "../harness/journey/journeyHarness.js";
import { CommandRunner } from "../harness/commandRunner.js";
import { renderMarkdown, postPrComment } from "../core/reporting/reporter.js";
import { publishEvidenceArtifacts, EVIDENCE_BRANCH } from "../core/reporting/evidenceUpload.js";
import {
  computeMetrics,
  renderMetricsMarkdown,
  filterEvents,
  computeTrend,
  renderTrendMarkdown,
} from "../core/reporting/metrics.js";
import { readVerdictInputs, replayVerdict } from "../core/verdict/replay.js";
import { buildStepSummary } from "./step.js";
import { runInit } from "./init.js";
import { runDoctor, renderDoctorReport } from "./doctor.js";
import { runOnboard, renderOnboardReport } from "./onboard.js";
import { memoryLs, memoryShow, memoryClear, isValidRepoArg } from "./memory.js";
import { recordFalsePositiveFromRun, feedbackLs, feedbackClear, listRecentRuns, latestRunForPr } from "./feedback.js";
import { captureIssue, issueContextFromRun, issueLs, renderIssue } from "./issue.js";
import { showRun, showSignal, isUnsafeRunId } from "./inspect.js";
import {
  watchTick,
  ghListOpenPrs,
  ghListIssueComments,
  ghMergePr,
  type WatchDeps,
  type WatchObserver,
} from "./watch.js";
import { green, red, yellow, cyan, dim, bold, colorizeVerdict } from "../util/color.js";

const RESULT_LABEL: Record<string, string> = {
  pass: "✓ pass",
  fail: "✗ fail",
  partial: "~ partial",
  not_evaluable: "? not_evaluable",
  blocked: "⊘ blocked",
};

/** Color a criterion result label by outcome. No-op when color is disabled (non-TTY/NO_COLOR). */
function paintResult(result: string, label: string): string {
  switch (result) {
    case "pass":
      return green(label);
    case "fail":
      return red(label);
    case "partial":
      return yellow(label);
    default:
      return dim(label);
  }
}

function printCriterionTable(report: RunReport): void {
  const results = report.criterionResults;
  if (!results.length) return;
  const bar = dim("─".repeat(70));
  console.error(`\n${bar}`);
  for (const c of results) {
    const raw = RESULT_LABEL[c.result] ?? c.result;
    // Pad before coloring so ANSI codes don't count toward the column width.
    const label = paintResult(c.result, raw.padEnd(14));
    const conf = c.confidence.toFixed(2);
    const text = c.criterion.length > 55 ? c.criterion.slice(0, 52) + "..." : c.criterion;
    console.error(`  ${cyan(c.criterionId.padEnd(5))}  ${label}  ${dim(conf)}  ${text}`);
  }
  const pass = results.filter(r => r.result === "pass").length;
  const fail = results.filter(r => r.result === "fail").length;
  const partial = results.filter(r => r.result === "partial").length;
  const blocked = results.filter(r => r.result === "blocked" || r.result === "not_evaluable").length;
  const parts = [`${pass} pass`];
  if (fail) parts.push(`${fail} fail`);
  if (partial) parts.push(`${partial} partial`);
  if (blocked) parts.push(`${blocked} blocked/not_evaluable`);
  console.error(bar);
  console.error(`  Verdict: ${colorizeVerdict(report.runVerdict)}   ${dim(`(${parts.join(", ")})`)}`);
  console.error(`${bar}\n`);
}

const USAGE = `verifyflow — evidence-backed delivery verification

Usage:
  vf run    --linear <KEY|url> --pr <url|owner/repo#N|#N> --level <functional|ui|journey|auto> [options]
                                      Add --dry-run to print the resolved criteria + planned probes
                                      without executing anything (no checkout, exits 0).
  vf step   --pr <url> [options]      Orchestrator-facing step (Symphony, IN-569): advisory-only,
                                      auto-resolves the Linear issue from the PR (body or branch),
                                      checks out + executes + posts the report comment, and prints
                                      a single machine-readable JSON line to stdout. Never blocks.
  vf report [--out <dir>] [--json] [--since <date>] [--repo <owner/repo>] [--level <l>] [--trend]
                                      Aggregate accumulated runs into quality-intelligence metrics,
                                      scoped by the given filters.
  vf memory ls                        List repos with stored reusable test points + counts.
  vf memory show <key>                Dump a single stored test point (by its id).
  vf memory clear [--repo <o/r>] [--yes]
                                      Prune the reusable test-point memory (one repo, or all).
  vf feedback                         Interactive: pick a recent run + a not-passed criterion to
                                      flag as a false positive (IN-792). Future runs downgrade a
                                      matching criterion to blocked instead of re-flagging it.
  vf feedback --pr <N> --criterion <id> [--note <text>]
                                      Flag a criterion on the latest run for PR <N> (no run id
                                      needed). Or name the run exactly: vf feedback <runId> --criterion <id>.
  vf feedback ls                      List recorded false-positive feedback per repo.
  vf feedback clear [--repo <o/r>] [--yes]
                                      Prune recorded false-positive feedback (one repo, or all).
  vf issue "<description>" --repo <o/r>   [--note <text>]
  vf issue --from-run <runId> [--repo <o/r>]
                                      Capture a bug/error: the LLM analyzes it (root cause / impact
                                      / repro / fix) and it is persisted to memory (IN-807).
                                      --from-run pulls the error context from a past run's report.
  vf issue ls [--json]                List captured issues per repo.
  vf issue show <id>                  Dump one captured issue.
  vf replay <runId> [--out <dir>] [--json]
                                      Re-run the verdict engine against a past run's stored evidence
                                      — no probes/tests are executed.
  vf show   <runId> [--out <dir>] [--json]
                                      Re-render a past run's report.md (or report.json).
  vf signal <runId> [--out <dir>] [--json]
                                      Pretty-print a past run's improvement-signal.json.
  vf init [--dir <path>]              Scaffold a verifyflow.config.json (default: current directory).
  vf doctor                           Check tools/env are ready (gh, claude, uv, LINEAR_API_KEY,
                                      docker/podman for sandbox, Playwright for --level ui).
  vf onboard [--non-interactive]      Guided first-run setup: prints platform-specific fix commands
                                      for any missing prerequisite, with an optional interactive
                                      prompt for LINEAR_API_KEY. Stores no secrets.
  vf demo [--open]                    Offline demo — no credentials. Runs bundled fixtures and writes
                                      a report you can read.
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
  --level <level>        functional | ui (AI-driven browser) | journey (multi-step end-to-end) |
                         auto (pick the level from the ticket's criteria; downgrade to functional
                         if the environment can't run a browser level, and say why).
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
  --dry-run              (run) Resolve criteria + build the plan and print it, without executing.
  -h, --help             Show this help.
  -v, --version          Print the verifyflow version and exit.

Auth model: VerifyFlow stores no secrets. It uses the authorized CLIs you have installed —
  gh (GitHub), claude (LLM), git/uv (execution). Linear: set LINEAR_API_KEY or use --fixtures.
`;

interface Args {
  [k: string]: string | boolean | undefined;
}

function parseArgs(argv: string[]): { cmd: string; args: Args; positionals: string[] } {
  const cmd = argv[0] ?? "";
  const args: Args = {};
  const positionals: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") args.help = true;
    else if (a === "-v" || a === "--version") args.version = true;
    else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) args[key] = true;
      else {
        args[key] = next;
        i++;
      }
    } else {
      positionals.push(a);
    }
  }
  return { cmd, args, positionals };
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

/**
 * Build the Linear + GitHub context clients honoring --fixtures (offline) vs live mode. Returns
 * an exit code on a usage error (e.g. live mode without LINEAR_API_KEY). Shared by `run`/`step`
 * (execution) and `run --dry-run` (planning only).
 */
async function buildContextClients(
  args: Args,
): Promise<{ linear: LinearClient; github: GhCliClient | FixtureGithubClient; fixtures?: string } | number> {
  const fixtures = str(args.fixtures);
  if (fixtures) {
    const dir = path.resolve(fixtures);
    return { linear: new FixtureLinearClient(dir), github: new FixtureGithubClient(dir), fixtures };
  }
  const key = await resolveLinearApiKey();
  if (!key) {
    console.error(
      "error: live mode needs a Linear API key (Linear is the criteria source). " +
        "Set LINEAR_API_KEY, or run `vf onboard` to save it to ~/.verifyflow/credentials.json, " +
        "or pass --fixtures <dir> for offline runs.",
    );
    return 2;
  }
  return { linear: new LinearApiClient(key), github: new GhCliClient() };
}

interface RunOutcome {
  report: Awaited<ReturnType<typeof runVerification>>["report"];
  runDir: string;
  reportPaths: Awaited<ReturnType<typeof runVerification>>["reportPaths"];
  signalPath?: string;
  prCommentPosted: boolean;
  prCommentUrl?: string;
}

/**
 * Shared run executor behind `vf run` and `vf step`: validates args, builds clients,
 * checks out the PR head when asked, runs the verification pipeline, and performs the
 * PR-comment / Linear write-backs. Writes only to stderr — stdout is owned by the caller
 * (markdown for `run`, a single JSON line for `step`).
 */
async function executeRun(
  args: Args,
  opts: { onProgress?: (msg: string) => void } = {},
): Promise<RunOutcome | number> {
  const pr = str(args.pr);
  const level = (str(args.level) ?? "functional") as Level | "auto";
  if (!pr) {
    console.error(
      "error: no PR — pass --pr <url|owner/repo#N|#N>, or run inside a repo checkout on a branch " +
        "with an open PR (VerifyFlow infers it via `gh pr view`).\n",
    );
    console.error(USAGE);
    return 2;
  }
  if (level !== "functional" && level !== "ui" && level !== "journey" && level !== "auto") {
    console.error(`error: unknown level "${level}" (functional, ui, journey, auto).`);
    return 2;
  }

  const outputRoot = path.resolve(str(args.out) ?? ".verifyflow");
  const policy = (str(args.policy) ?? "advisory") as Policy;
  if (!["advisory", "merge_gate", "strict"].includes(policy)) {
    console.error(`error: unknown --policy "${policy}" (expected advisory | merge_gate | strict).`);
    return 2;
  }
  // Build context clients.
  const clients = await buildContextClients(args);
  if (typeof clients === "number") return clients;
  const { linear, github, fixtures } = clients;

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

  // For ui/journey levels: resolve a live app URL (explicit → preview → local) and build the
  // AI-driven harness. The browser is an optional dependency; without it (and, for journey,
  // without a checkout for backend steps) we leave the harness undefined / capability-less so the
  // pipeline blocks the criteria rather than false-passing them (IN-606 / IN-661).
  let resolvedBaseUrl = str(args["base-url"]);
  let uiHarnessFactory: ((artifactRoot: string) => UiHarness) | undefined;
  let journeyHarnessFactory: ((artifactRoot: string) => JourneyHarness) | undefined;
  let appCleanup: (() => Promise<void>) | undefined;
  // Environment readiness for the browser-backed levels — also feeds `--level auto` selection.
  let appReady = false;
  let playwrightAvailable = false;
  if ((level === "ui" || level === "journey" || level === "auto") && !fixtures) {
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
      appReady = true;
      console.error(`[verifyflow] ${level} app source: ${source.source} → ${source.baseUrl}`);
    } else {
      console.error(`[verifyflow] ${level}: ${source.reason} — browser steps will be environment-blocked.`);
    }

    const driver = new PlaywrightBrowserDriver();
    const browserOk = await driver.available();
    playwrightAvailable = browserOk;
    if (!browserOk) {
      console.error(
        "[verifyflow] " + level + ": Playwright not installed — install with " +
          "`npm i -D playwright && npx playwright install chromium`. Browser steps will be blocked.",
      );
    }
    const auth = str(args["ui-auth"]);
    // For `auto` we prepare BOTH harnesses; the pipeline picks the level from the criteria and uses
    // only the matching one. For an explicit level we prepare just that one.
    if ((level === "ui" || level === "auto") && browserOk) {
      uiHarnessFactory = (artifactRoot) =>
        new AgenticUiHarness({ driver, llm, artifactsDir: artifactRoot, storageStatePath: auth });
    }
    if (level === "journey" || level === "auto") {
      // journey: backend steps run shell commands in the checkout (if any); browser steps use the
      // driver (if installed). With neither, the harness has no capability → criteria block.
      const resolvedWorkdir = workdir ? path.resolve(workdir) : undefined;
      if (!resolvedWorkdir && level === "journey") {
        console.error(
          "[verifyflow] journey: no --workdir/--checkout — backend steps will be blocked (browser steps only).",
        );
      }
      journeyHarnessFactory = (artifactRoot) => {
        const runCommand = resolvedWorkdir
          ? async (command: string, label: string): Promise<CommandOutcome> => {
              const runner = new CommandRunner(resolvedWorkdir, artifactRoot, { isolate: !args["no-sandbox"] });
              const r = await runner.runStep({
                id: `probe-${label}`,
                kind: "command",
                command,
                description: `journey backend step ${label}`,
                criterionIds: [],
                reusedTestPoint: false,
              });
              return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, evidence: r.evidence };
            }
          : undefined;
        return new AgenticJourneyHarness({
          llm,
          artifactsDir: artifactRoot,
          runCommand,
          driver: browserOk ? driver : undefined,
          storageStatePath: auth,
        });
      };
    }
  }

  const request: RunRequest = {
    linearIssue: str(args.linear) ?? "",
    pullRequest: pr,
    // `auto` is resolved inside the pipeline once criteria exist; carry a functional placeholder.
    level: level === "auto" ? "functional" : level,
    autoSelect: level === "auto" ? { appAvailable: appReady, playwrightAvailable } : undefined,
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
    journeyHarnessFactory,
    // Default progress sink prefixes with the [verifyflow] tag; callers (e.g. vf watch) can
    // override to attach per-PR context.
    onProgress: opts.onProgress ?? ((msg) => console.error(`${dim("[verifyflow]")} ${msg}`)),
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

  printCriterionTable(report);

  console.error(`\n[verifyflow] reports: ${reportPaths.markdownPath} | ${reportPaths.jsonPath}`);
  if (signalPath) {
    console.error(`[verifyflow] bounce-back signal (feed to the coding agent): ${signalPath}`);
  }

  let prCommentPosted = false;
  let prCommentUrl: string | undefined;
  if (args.comment && !fixtures) {
    // IN-675: host visual evidence (screenshots/trace) so the comment can embed it; best-effort,
    // an empty map just falls back to bare on-disk paths.
    const evidenceUrls = await publishEvidenceArtifacts(report, runDir);
    if (Object.keys(evidenceUrls).length) {
      console.error(`[verifyflow] hosted ${Object.keys(evidenceUrls).length} evidence artifact(s) on ${EVIDENCE_BRANCH}.`);
    }
    prCommentUrl = await postPrComment(report, renderMarkdown(report, { evidenceUrls }));
    prCommentPosted = prCommentUrl !== undefined;
    if (prCommentUrl) {
      console.error(`[verifyflow] evidence: ${prCommentUrl}`);
    } else {
      console.error("[verifyflow] failed to post PR comment.");
    }
  }

  if (args["linear-writeback"] && !fixtures && linear.addComment && report.issue.source !== "pr-degraded") {
    const ok = await linear.addComment(
      report.issue.key,
      `VerifyFlow delivery verdict: **${report.runVerdict}**. ${report.summary}`,
    );
    console.error(ok ? "[verifyflow] posted Linear comment." : "[verifyflow] failed to post Linear comment.");
  }

  return { report, runDir, reportPaths, signalPath, prCommentPosted, prCommentUrl };
}

/**
 * IN-678: fill omitted context from the current git checkout so `vf run` works with no flags.
 * Additive — only fires when a flag is absent, and skips entirely in --fixtures (offline) mode.
 * Mutates `args` in place. Applies to `vf run` (incl. --dry-run); never to `vf step` / `vf watch`.
 */
async function applyContextInference(args: Args): Promise<void> {
  if (args.fixtures) return;
  if (!(await inGitRepo())) return;

  if (!str(args.pr)) {
    const inferred = await inferPrRef();
    if (inferred.ref) {
      args.pr = inferred.ref;
      console.error(`[verifyflow] inferred --pr from the current branch: ${inferred.ref}`);
    } else if (inferred.reason) {
      console.error(`[verifyflow] could not infer --pr: ${inferred.reason}`);
    }
  }

  // Default execution to the current working tree when neither --workdir nor --checkout was given,
  // so a zero-flag `vf run` actually executes against the repo you're standing in.
  if (!str(args.workdir) && !args.checkout) {
    args.workdir = ".";
    console.error("[verifyflow] no --workdir/--checkout: verifying the current working tree (.)");
  }
}

async function cmdRun(args: Args): Promise<number> {
  await applyContextInference(args);
  if (args["dry-run"]) return cmdDryRun(args);

  const outcome = await executeRun(args);
  if (typeof outcome === "number") return outcome;

  console.log(renderMarkdown(outcome.report));

  if (outcome.report.gate?.blocked) return 1;
  return 0;
}

/** Render a `vf run --dry-run` plan preview for the terminal. */
function renderPlanPreview(p: PlanPreview): string {
  const lines: string[] = [];
  lines.push(`# Dry run — ${p.issue.key}: ${p.issue.title}`);
  if (p.degraded) lines.push("> ⚠️ degraded (no ticket): criteria derived from the PR's own description.");
  lines.push("");
  lines.push(`## Resolved acceptance criteria (${p.criteria.criteria.length})`);
  for (const c of p.criteria.criteria) {
    const flags = `${c.source}, ${c.method}, ${c.observable ? "observable" : "not observable"}`;
    lines.push(`- ${c.id} [${flags}]: ${c.text}`);
    if (c.probe) lines.push(`    probe: ${c.probe.command}${c.probe.fromTicket ? " (from ticket)" : ""}`);
  }
  if (p.criteria.ticketQualityIssues.length) {
    lines.push("");
    lines.push("## Ticket quality notes");
    for (const q of p.criteria.ticketQualityIssues) lines.push(`- ${q}`);
  }
  lines.push("");
  lines.push(`## Planned steps (${p.plan.steps.length}) — level ${p.plan.level}`);
  if (p.plan.environmentUnknown) lines.push(`> environment unknown: ${p.plan.environmentUnknown.reason}`);
  for (const s of p.plan.steps) {
    const tag = s.reusedTestPoint ? " _(reused memory test point)_" : "";
    lines.push(`- ${s.id}: ${s.description}${tag}${s.command ? ` → ${s.command}` : ""}`);
  }
  if (p.plan.notes.length) {
    lines.push("");
    lines.push("## Plan notes");
    for (const n of p.plan.notes) lines.push(`- ${n}`);
  }
  if (p.plan.escalationRecommended) {
    lines.push("");
    lines.push(
      `> escalation recommended to ${p.plan.escalationRecommended.toLevel}: ${p.plan.escalationRecommended.reason}`,
    );
  }
  lines.push("");
  lines.push("(dry run — no probes or tests were executed.)");
  return lines.join("\n");
}

/** `vf run --dry-run` (IN-625): resolve criteria + build the plan, print it, run nothing. */
async function cmdDryRun(args: Args): Promise<number> {
  const pr = str(args.pr);
  const level = (str(args.level) ?? "functional") as Level | "auto";
  if (!pr) {
    console.error(
      "error: no PR — pass --pr <url|owner/repo#N|#N>, or run inside a repo checkout on a branch " +
        "with an open PR (VerifyFlow infers it via `gh pr view`).\n",
    );
    console.error(USAGE);
    return 2;
  }
  // Mirror executeRun's guard: accept the known levels (journey is seam-only until Phase 2 —
  // its criteria block rather than execute), reject anything else.
  if (level !== "functional" && level !== "ui" && level !== "journey" && level !== "auto") {
    console.error(`error: unknown level "${level}" (functional, ui, journey, auto).`);
    return 2;
  }
  const outputRoot = path.resolve(str(args.out) ?? ".verifyflow");
  const clients = await buildContextClients(args);
  if (typeof clients === "number") return clients;
  const llm = await buildLlm(args);

  const request: RunRequest = {
    linearIssue: str(args.linear) ?? "",
    pullRequest: pr,
    // `auto` is resolved inside planRun from the criteria; carry a functional placeholder. In dry
    // run we assume the browser env is ready so the preview shows the level the TICKET needs — it
    // executes nothing, so a locally missing browser/app shouldn't mask the intended level.
    level: level === "auto" ? "functional" : level,
    autoSelect: level === "auto" ? { appAvailable: true, playwrightAvailable: true } : undefined,
    policy: "advisory",
    outputRoot,
    workdir: str(args.workdir) ? path.resolve(str(args.workdir)!) : undefined,
    allowNoTicket: !!args["allow-no-ticket"],
  };
  // planRun only reads from memory (to surface reused test points); it never writes, and the
  // EventLog here is never appended to. Both are constructed only to satisfy PipelineDeps — dry-run
  // stays side-effect-free, consistent with the "prints the plan, runs nothing" contract.
  const deps: PipelineDeps = {
    linear: clients.linear,
    github: clients.github,
    llm,
    memory: new MemoryStore(outputRoot),
    eventLog: new EventLog(outputRoot),
  };
  // `--linear` is optional: when omitted, resolveContext derives the issue key from the PR body or
  // branch (and --allow-no-ticket enables degraded mode). If neither yields a ticket, surface that
  // clear, actionable message and exit 2 — never a fatal stack trace from deep in the pipeline.
  let preview: PlanPreview;
  try {
    preview = await planRun(request, deps);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  // Prepend model-tiering note so the dry-run makes the routing decision visible.
  if (llm instanceof ClaudeCliClient) {
    preview.plan.notes.unshift(`LLM model tiering: ${llm.modelDescription()}`);
  }
  // `--json` emits the machine-readable preview for tooling; the default markdown is for humans.
  console.log(args.json ? JSON.stringify(preview, null, 2) : renderPlanPreview(preview));
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
  const all = await new EventLog(outputRoot).readAll();
  if (all.length === 0) {
    console.error(`[verifyflow] no events found under ${outputRoot} — run \`vf run\` first.`);
    return 0;
  }
  // Scope filters (IN-625): narrow the event log before computing metrics.
  const filter = { since: str(args.since), repo: str(args.repo), level: str(args.level) };
  // An unparsable --since is ignored by filterEvents (treated as no lower bound). Surface that
  // on stderr — in both text and JSON modes — so a typo'd date isn't silently dropped (review).
  if (filter.since && Number.isNaN(Date.parse(filter.since))) {
    console.error(
      `[verifyflow] warning: could not parse --since "${filter.since}" — ignoring the date filter.`,
    );
  }
  const events = filterEvents(all, filter);
  // An unparseable `--since` is ignored by filterEvents, so don't count it as applied — otherwise
  // the scope message would advertise a filter that wasn't actually used (IN-625 review).
  const sinceApplied = Boolean(filter.since) && !Number.isNaN(Date.parse(filter.since!));
  const scoped = sinceApplied || Boolean(filter.repo) || Boolean(filter.level);
  if (events.length === 0) {
    console.error(
      `[verifyflow] no events match the given filter (since=${filter.since ?? "-"}, ` +
        `repo=${filter.repo ?? "-"}, level=${filter.level ?? "-"}).`,
    );
    return 0;
  }
  const metrics = computeMetrics(events);
  const wantTrend = !!args.trend;
  if (args.json) {
    const payload = wantTrend ? { ...metrics, trend: computeTrend(events) } : metrics;
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }
  if (scoped) {
    const f = [
      sinceApplied ? `since ${filter.since}` : null,
      filter.repo ? `repo ${filter.repo}` : null,
      filter.level ? `level ${filter.level}` : null,
    ].filter(Boolean);
    console.error(`[verifyflow] scope: ${f.join(", ")} — ${events.length}/${all.length} event(s).`);
  }
  let out = renderMetricsMarkdown(metrics);
  if (wantTrend) out += "\n" + renderTrendMarkdown(computeTrend(events));
  console.log(out);
  return 0;
}

/** `vf init [--dir <path>]` — scaffold a per-repo config (IN-611). */
async function cmdInit(args: Args): Promise<number> {
  const dir = str(args.dir) ? path.resolve(str(args.dir)!) : process.cwd();
  const res = await runInit(dir);
  if (res.created) {
    const detection = res.detected ? ` (detected: ${res.detected})` : " (generic template — edit for your stack)";
    console.log(`created ${res.path}${detection}`);
    if (!res.detected) console.log("Edit setup / test / runPrefix for your stack, then run: vf run --help");
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

/**
 * `vf onboard` (#41): guided first-run setup. Runs the doctor checks and prints platform-specific
 * fix commands for whatever's missing. Interactive in a TTY (offers to inline a pasted LINEAR key
 * into the export command); falls back to a placeholder under --non-interactive or non-TTY.
 */
async function cmdOnboard(args: Args): Promise<number> {
  const nonInteractive = !!args["non-interactive"] || !process.stdin.isTTY;
  const prompt = nonInteractive
    ? undefined
    : async (q: string) => {
        // Prompt goes to stderr so stdout stays reserved for the rendered report.
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        try {
          return await rl.question(q);
        } catch {
          return "";
        } finally {
          rl.close();
        }
      };
  const report = await runOnboard({ prompt });
  console.log(renderOnboardReport(report));
  // Exit 1 when a required step remains so CI / scripted bootstraps surface the failure.
  return report.ready ? 0 : 1;
}

/** `vf memory ls|show <key>|clear [--repo ...] [--yes]` (IN-625): inspect/prune reusable memory. */
async function cmdMemory(args: Args, positionals: string[]): Promise<number> {
  const outputRoot = path.resolve(str(args.out) ?? ".verifyflow");
  const store = new MemoryStore(outputRoot);
  const sub = positionals[0] ?? "ls";

  if (sub === "ls") {
    const res = await memoryLs(store);
    console.log(args.json ? JSON.stringify(res.json, null, 2) : res.text);
    return 0;
  }
  if (sub === "show") {
    const key = positionals[1];
    if (!key) {
      console.error("error: vf memory show <key> needs a test point id (list them with `vf memory ls`).");
      return 2;
    }
    const res = await memoryShow(store, key);
    if (!res.found) {
      console.error(res.text);
      return 1;
    }
    console.log(args.json ? JSON.stringify(res.point, null, 2) : res.text);
    return 0;
  }
  if (sub === "clear") {
    const repo = str(args.repo);
    if (repo !== undefined && !isValidRepoArg(repo)) {
      console.error(`error: --repo must look like owner/repo (got "${repo}").`);
      return 2;
    }
    if (!args.yes) {
      const scope = repo ? `memory for ${repo}` : "ALL reusable test-point memory";
      const ok = await confirm(`This will delete ${scope} under ${outputRoot}. Continue? [y/N] `);
      if (!ok) {
        // A user-cancelled prune is not an error — exit 0 so wrapping automation doesn't trip.
        console.error("aborted.");
        return 0;
      }
    }
    const res = await memoryClear(store, repo);
    console.log(res.text);
    return 0;
  }

  console.error(`error: unknown memory subcommand "${sub}" (expected ls | show | clear).`);
  return 2;
}

/** Prompt for a single line on stdin (stderr-side, so stdout stays clean). undefined on non-tty/EOF. */
async function promptLine(question: string): Promise<string | undefined> {
  if (!process.stdin.isTTY) return undefined;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } catch {
    return undefined;
  } finally {
    rl.close();
  }
}

/** Prompt for a 1-based menu choice; returns the 0-based index, or undefined on abort/invalid. */
async function promptIndex(question: string, max: number): Promise<number | undefined> {
  const ans = await promptLine(question);
  if (ans === undefined) return undefined;
  const n = Number(ans.trim());
  if (!Number.isInteger(n) || n < 1 || n > max) return undefined;
  return n - 1;
}

/** Prompt for a yes/no confirmation on stdin. Returns false on EOF / non-tty. */
async function confirm(question: string): Promise<boolean> {
  // No interactive terminal (CI, piped stdin): don't block on `.question()` waiting for input that
  // will never come — decline so callers must pass --yes for a non-interactive clear.
  if (!process.stdin.isTTY) return false;
  // Prompt goes to stderr (not stdout) on purpose: stdout stays reserved for the command's real
  // output (e.g. piping `vf memory ...`), so the interactive prompt never pollutes it.
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } catch {
    return false;
  } finally {
    rl.close();
  }
}

/**
 * `vf feedback` (IN-792): the human false-positive correction channel. Records a misjudged
 * criterion so future runs downgrade it to `blocked` instead of re-flagging it.
 */
async function cmdFeedback(args: Args, positionals: string[]): Promise<number> {
  const outputRoot = path.resolve(str(args.out) ?? ".verifyflow");
  const store = new MemoryStore(outputRoot);
  const sub = positionals[0] ?? "";

  if (sub === "ls") {
    const res = await feedbackLs(store);
    console.log(args.json ? JSON.stringify(res.json, null, 2) : res.text);
    return 0;
  }
  if (sub === "clear") {
    const repo = str(args.repo);
    if (repo !== undefined && !isValidRepoArg(repo)) {
      console.error(`error: --repo must look like owner/repo (got "${repo}").`);
      return 2;
    }
    if (!args.yes) {
      const scope = repo ? `feedback for ${repo}` : "ALL false-positive feedback";
      const ok = await confirm(`This will delete ${scope} under ${outputRoot}. Continue? [y/N] `);
      if (!ok) {
        console.error("aborted.");
        return 0;
      }
    }
    const res = await feedbackClear(store, repo);
    console.log(res.text);
    return 0;
  }

  // Three ways to name the run (most to least explicit): a positional <runId>, `--run <id>`, or
  // `--pr <N>` (latest run for that PR — disambiguates when several PRs are in flight).
  let runId = sub || str(args.run);
  if (!runId && str(args.pr)) {
    const prNum = Number(String(str(args.pr)).replace(/^#/, ""));
    if (!Number.isInteger(prNum)) {
      console.error("error: --pr must be a PR number.");
      return 2;
    }
    runId = await latestRunForPr(outputRoot, prNum);
    if (!runId) {
      console.error(`feedback: no run found for PR #${prNum} under ${path.join(outputRoot, "runs")}.`);
      return 1;
    }
  }
  let criterionId = str(args.criterion);
  let note = str(args.note);

  // Interactive: nothing named → list recent runs and walk the user through it (TTY only).
  if (!runId && !criterionId) {
    if (!process.stdin.isTTY) {
      console.error(
        "error: vf feedback needs a TTY for interactive mode — or name the run with `--pr <N> --criterion <id>` " +
          "or `<runId> --criterion <id>`. See `vf feedback ls`.",
      );
      return 2;
    }
    const runs = await listRecentRuns(outputRoot);
    if (runs.length === 0) {
      console.error(`feedback: no runs found under ${path.join(outputRoot, "runs")} — run \`vf run\` first.`);
      return 1;
    }
    console.error("Recent runs:");
    runs.forEach((r, i) => {
      const fails = r.failed.length ? `${r.failed.length} not-passed` : "all passed";
      console.error(`  ${i + 1}) PR #${r.prNumber} ${r.issue} — ${dim(fails)} ${dim(`(${r.runId})`)}`);
    });
    const ri = await promptIndex(`Pick a run [1-${runs.length}]: `, runs.length);
    if (ri === undefined) {
      console.error("aborted.");
      return 0;
    }
    const chosen = runs[ri]!;
    runId = chosen.runId;
    if (chosen.failed.length === 0) {
      console.error(`feedback: PR #${chosen.prNumber}'s run has no fail/partial criteria to flag.`);
      return 1;
    }
    console.error(`\nNot-passed criteria for PR #${chosen.prNumber}:`);
    chosen.failed.forEach((c, i) =>
      console.error(`  ${i + 1}) ${cyan(c.criterionId)} [${colorizeVerdict(c.result)}] — ${c.criterion.slice(0, 70)}`),
    );
    const ci = await promptIndex(`Mark which as a false positive? [1-${chosen.failed.length}]: `, chosen.failed.length);
    if (ci === undefined) {
      console.error("aborted.");
      return 0;
    }
    criterionId = chosen.failed[ci]!.criterionId;
    if (note === undefined) {
      const n = await promptLine("Optional note (Enter to skip): ");
      note = n && n.trim() ? n.trim() : undefined;
    }
  }

  if (!runId) {
    console.error("error: name the run — `vf feedback --pr <N> --criterion <id>`, `vf feedback <runId> --criterion <id>`, or `vf feedback` for the interactive picker.");
    return 2;
  }
  if (!criterionId) {
    console.error("error: vf feedback needs --criterion <id> (the AC id from the run's report).");
    return 2;
  }
  const res = await recordFalsePositiveFromRun(store, outputRoot, runId, criterionId, new Date().toISOString(), note);
  if (!res.ok) {
    console.error(res.text);
    return 1;
  }
  console.log(res.text);
  return 0;
}

/**
 * `vf issue` (IN-807): capture a bug/error, have the LLM analyze it, and persist it to memory.
 *   vf issue "<description>"            analyze + store a reported bug
 *   vf issue --from-run <runId>         pull error context from a past run and analyze it
 *   vf issue ls [--json]               list captured issues per repo
 *   vf issue show <id>                 dump one captured issue
 */
async function cmdIssue(args: Args, positionals: string[]): Promise<number> {
  const outputRoot = path.resolve(str(args.out) ?? ".verifyflow");
  const store = new MemoryStore(outputRoot);
  const sub = positionals[0] ?? "";

  if (sub === "ls") {
    const res = await issueLs(store);
    console.log(args.json ? JSON.stringify(res.json, null, 2) : res.text);
    return 0;
  }
  if (sub === "show") {
    const id = positionals[1];
    if (!id) {
      console.error("error: vf issue show <id> needs an issue id (list them with `vf issue ls`).");
      return 2;
    }
    const rec = await store.findIssue(id);
    if (!rec) {
      console.error(`issue: no captured issue with id "${id}".`);
      return 1;
    }
    console.log(args.json ? JSON.stringify(rec, null, 2) : renderIssue(rec));
    return 0;
  }

  // Capture: either from a run, or from free text.
  let input: string;
  let source: string;
  let repo: string | undefined = str(args.repo);
  const fromRun = str(args["from-run"]);
  if (fromRun) {
    const ctx = await issueContextFromRun(outputRoot, fromRun);
    if (!ctx.ok) {
      console.error(ctx.text!);
      return 1;
    }
    input = ctx.input!;
    source = `run:${fromRun}`;
    repo = repo ?? ctx.repo;
  } else {
    input = positionals.join(" ").trim();
    if (!input) {
      console.error('error: vf issue "<description>"  (or --from-run <runId>, or `ls` / `show <id>`).');
      return 2;
    }
    source = "manual";
  }
  if (!repo) {
    console.error("error: vf issue needs --repo <owner/repo> (couldn't resolve it; only --from-run derives it automatically).");
    return 2;
  }

  const llm = await buildLlm(args);
  const res = await captureIssue(store, llm, { repo, input, source, note: str(args.note), now: new Date().toISOString() });
  console.log(res.text);
  return 0;
}

/** `vf replay <runId>` (IN-625): re-run the verdict engine on a past run's stored evidence. */
async function cmdReplay(args: Args, positionals: string[]): Promise<number> {
  const runId = positionals[0];
  if (!runId) {
    console.error("error: vf replay <runId> needs a run id (see `.verifyflow/runs/`).");
    return 2;
  }
  if (isUnsafeRunId(runId)) {
    console.error(`error: invalid run id "${runId}" — must be a single run directory name.`);
    return 2;
  }
  const outputRoot = path.resolve(str(args.out) ?? ".verifyflow");
  const runDir = path.join(outputRoot, "runs", runId);
  let inputs;
  try {
    inputs = await readVerdictInputs(runDir);
  } catch {
    console.error(
      `error: no stored evidence for run "${runId}" (expected ${path.join(runDir, "verdict-inputs.json")}). ` +
        "Only runs recorded after this feature shipped can be replayed.",
    );
    return 2;
  }
  const llm = await buildLlm(args);
  const verdict = await replayVerdict(inputs, llm);

  if (args.json) {
    console.log(JSON.stringify(verdict, null, 2));
    return 0;
  }
  const lines: string[] = [];
  lines.push(`# Replay — ${runId}`);
  lines.push(`> Re-ran the verdict engine on stored evidence (no probes executed).`);
  lines.push("");
  lines.push(`Run verdict: **${verdict.runVerdict}**`);
  lines.push(`Summary: ${verdict.summary}`);
  lines.push("");
  lines.push("## Criteria");
  for (const c of verdict.criterionResults) {
    lines.push(`- ${c.criterionId} → ${c.result} (confidence ${c.confidence.toFixed(2)}): ${c.reason}`);
  }
  console.log(lines.join("\n"));
  return 0;
}

/** `vf show <runId>` (IN-625): re-render a past run's report.md (or report.json with --json). */
async function cmdShow(args: Args, positionals: string[]): Promise<number> {
  const runId = positionals[0];
  if (!runId) {
    console.error("error: vf show <runId> needs a run id (see `.verifyflow/runs/`).");
    return 2;
  }
  if (isUnsafeRunId(runId)) {
    console.error(`error: invalid run id "${runId}" — must be a single run directory name.`);
    return 2;
  }
  const outputRoot = path.resolve(str(args.out) ?? ".verifyflow");
  const res = await showRun(outputRoot, runId, !!args.json);
  if (!res.found) {
    console.error(res.text);
    return 1;
  }
  console.log(res.text);
  return 0;
}

/** `vf signal <runId>` (IN-625): pretty-print a past run's improvement-signal.json. */
async function cmdSignal(args: Args, positionals: string[]): Promise<number> {
  const runId = positionals[0];
  if (!runId) {
    console.error("error: vf signal <runId> needs a run id (see `.verifyflow/runs/`).");
    return 2;
  }
  if (isUnsafeRunId(runId)) {
    console.error(`error: invalid run id "${runId}" — must be a single run directory name.`);
    return 2;
  }
  const outputRoot = path.resolve(str(args.out) ?? ".verifyflow");
  const res = await showSignal(outputRoot, runId, !!args.json);
  if (res.corrupt) {
    // The run exists but its signal file is unreadable — a distinct failure from "no such run".
    console.error(res.text);
    return 1;
  }
  if (!res.found) {
    console.error(res.text);
    return 1;
  }
  console.log(res.text);
  return 0;
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
  const intervalSec = Number(str(args.interval) ?? "60");
  if (Number.isNaN(intervalSec)) {
    console.error("error: --interval must be a number of seconds\n");
    return 2;
  }
  if (intervalSec < 10) console.error("[verifyflow] --interval clamped to the 10s minimum.");
  const intervalMs = Math.max(10, intervalSec) * 1000;
  const autoMerge = !!args["auto-merge"];
  const level = str(args.level) ?? "functional";
  const seen = new Map<number, string>();

  const deps: WatchDeps = {
    listOpenPrs: ghListOpenPrs,
    listIssueComments: ghListIssueComments,
    verify: async (pr) => {
      const outcome = await executeRun(
        { pr: `${repo}#${pr.number}`, level, checkout: true, comment: true },
        // Attach the PR to each pipeline progress step so a watcher can tell which PR it belongs to.
        { onProgress: (msg) => console.error(`  ${cyan(`#${pr.number}`)} ${dim(msg)}`) },
      );
      if (typeof outcome === "number") return { verdict: "error", merged: false };
      const verdict = outcome.report.runVerdict;
      let merged = false;
      if (autoMerge && verdict === "accept") merged = await ghMergePr(repo, pr.number, pr.headSha);
      return { verdict, merged };
    },
  };

  // Per-tick heartbeat + per-PR start framing. Pure observability — never touches the decision core.
  const observer: WatchObserver = {
    tick: ({ open, alreadyVerified, toVerify }) => {
      const summary =
        `${open} open · ${alreadyVerified} already verified · ${toVerify} approved & pending`;
      console.error(
        toVerify > 0
          ? `${dim("[verifyflow] tick:")} ${summary}`
          : dim(`[verifyflow] tick: ${summary} — nothing to do`),
      );
    },
    verifyStart: (pr) => {
      const title = pr.title ? ` ${dim(`"${pr.title}"`)}` : "";
      console.error(`${bold("▶")} verifying ${cyan(`PR #${pr.number}`)}${title}`);
    },
  };

  console.error(
    `${dim("[verifyflow]")} vf watch on ${cyan(repo)} — every ${intervalMs / 1000}s, ` +
      `auto-merge: ${autoMerge ? green("on") : dim("off")} ${dim("(Ctrl-C to stop).")}`,
  );
  let stop = false;
  const onStop = () => {
    stop = true;
    console.error(dim("\n[verifyflow] stopping watch after the current tick…"));
  };
  process.once("SIGINT", onStop);
  process.once("SIGTERM", onStop); // containers / systemd / kill use SIGTERM
  while (!stop) {
    try {
      const acted = await watchTick(repo, deps, seen, observer);
      for (const a of acted) {
        // Outcome framing: ✔ for a merge, ✘ for an error, • otherwise. The PR title was already
        // shown by verifyStart, so the outcome line stays compact.
        const mergedNote = a.merged ? green(" (merged)") : "";
        const icon = a.error ? red("✘") : a.merged ? green("✔") : dim("•");
        console.error(
          `${icon} ${cyan(`PR #${a.pr}`)}${dim(`@${a.headSha.slice(0, 8)}`)} → ` +
            `${colorizeVerdict(a.verdict)}${mergedNote}` +
            (a.error ? ` ${red(a.error)}` : ""),
        );
      }
    } catch (err) {
      console.error(`${red("[verifyflow] watch tick error:")} ${err instanceof Error ? err.message : String(err)}`);
    }
    if (stop) break;
    await sleep(intervalMs);
  }
  return 0;
}

/**
 * `vf demo` (IN-692): zero-credential offline demo. Runs the bundled fixture data through
 * the full verification pipeline without hitting any external API or requiring a claude CLI.
 * Writes a report to a temp directory and prints a concise summary to stdout.
 */
async function cmdDemo(args: Args): Promise<number> {
  // Resolve fixture paths relative to this file's package root.
  // At runtime the compiled file lives at dist/cli/main.js, so the package root is two levels up.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const PKG_ROOT = path.resolve(__dirname, "..", "..");
  const fixturesDir = path.join(PKG_ROOT, "fixtures", "example-cli");
  const workdir = path.join(PKG_ROOT, "examples", "example-target");
  const tempDir = path.join(os.tmpdir(), `verifyflow-demo-${Date.now()}`);

  console.error("[verifyflow] Running offline demo — no credentials needed...");

  const demoArgs: Args = {
    fixtures: fixturesDir,
    linear: "EX-1",
    pr: "example/greet#7",
    level: "functional",
    out: tempDir,
    workdir: workdir,
  };

  const outcome = await executeRun(demoArgs);
  if (typeof outcome === "number") return outcome;

  const { report, reportPaths } = outcome;
  const criteriaCount = report.criterionResults.length;

  console.log(`verdict:    ${report.runVerdict}`);
  console.log(`criteria:   ${criteriaCount} evaluated`);
  console.log(`report:     ${reportPaths.markdownPath}`);

  if (args.open) {
    const openCmd =
      process.platform === "darwin" ? "open" :
      process.platform === "win32" ? "start" :
      "xdg-open";
    const { spawn } = await import("node:child_process");
    spawn(openCmd, [reportPaths.markdownPath], { detached: true, stdio: "ignore" }).unref();
  }

  return 0;
}

async function main(): Promise<number> {
  const { cmd, args, positionals } = parseArgs(process.argv.slice(2));
  // `--version` / `-v`: print the package version (read from package.json) and exit 0.
  // Handled before `--help` so `vf --version` doesn't fall through to usage.
  if (args.version || cmd === "--version" || cmd === "-v") {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // Resolve package.json relative to this module: src/cli/main.ts → ../../package.json
    // (and dist/cli/main.js → ../../package.json), so both run modes work.
    const pkgPath = path.resolve(here, "..", "..", "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { version: string };
    console.log(`verifyflow ${pkg.version}`);
    return 0;
  }
  // `help`, `--help`/`-h` as the first token, or any `--help`/`-h` flag → usage (exit 0).
  // An empty invocation still prints usage but exits 2 (nothing to do).
  if (args.help || cmd === "" || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return cmd === "" ? 2 : 0;
  }
  if (cmd === "run") return cmdRun(args);
  if (cmd === "step") return cmdStep(args);
  if (cmd === "report") return cmdReport(args);
  if (cmd === "memory") return cmdMemory(args, positionals);
  if (cmd === "feedback") return cmdFeedback(args, positionals);
  if (cmd === "issue") return cmdIssue(args, positionals);
  if (cmd === "replay") return cmdReplay(args, positionals);
  if (cmd === "show") return cmdShow(args, positionals);
  if (cmd === "signal") return cmdSignal(args, positionals);
  if (cmd === "init") return cmdInit(args);
  if (cmd === "doctor") return cmdDoctor();
  if (cmd === "onboard") return cmdOnboard(args);
  if (cmd === "demo") return cmdDemo(args);
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
