#!/usr/bin/env node
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { runVerification, planRun, type PipelineDeps, type PlanPreview } from "../core/pipeline.js";
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
import { memoryLs, memoryShow, memoryClear, isValidRepoArg } from "./memory.js";
import { showRun, showSignal, isUnsafeRunId } from "./inspect.js";
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
  --dry-run              (run) Resolve criteria + build the plan and print it, without executing.
  -h, --help             Show this help.

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
function buildContextClients(
  args: Args,
): { linear: LinearClient; github: GhCliClient | FixtureGithubClient; fixtures?: string } | number {
  const fixtures = str(args.fixtures);
  if (fixtures) {
    const dir = path.resolve(fixtures);
    return { linear: new FixtureLinearClient(dir), github: new FixtureGithubClient(dir), fixtures };
  }
  const key = process.env.LINEAR_API_KEY;
  if (!key) {
    console.error(
      "error: live mode needs LINEAR_API_KEY (Linear is the criteria source). " +
        "Use --fixtures <dir> for offline runs, or capture the issue via the Linear connector.",
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
  // Build context clients.
  const clients = buildContextClients(args);
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
  const level = (str(args.level) ?? "functional") as Level;
  if (!pr) {
    console.error("error: --pr is required\n");
    console.error(USAGE);
    return 2;
  }
  // Mirror executeRun's guard: `journey` is a valid Level in the type system but is not yet
  // implemented in either the real run or this preview, so reject it the same way here.
  if (level !== "functional" && level !== "ui") {
    console.error(`error: level "${level}" is not implemented yet (functional, ui).`);
    return 2;
  }
  const outputRoot = path.resolve(str(args.out) ?? ".verifyflow");
  const clients = buildContextClients(args);
  if (typeof clients === "number") return clients;
  const llm = await buildLlm(args);

  const request: RunRequest = {
    linearIssue: str(args.linear) ?? "",
    pullRequest: pr,
    level,
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

/** Prompt for a yes/no confirmation on stdin. Returns false on EOF / non-tty. */
async function confirm(question: string): Promise<boolean> {
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
  const onStop = () => {
    stop = true;
    console.error("\n[verifyflow] stopping watch after the current tick…");
  };
  process.once("SIGINT", onStop);
  process.once("SIGTERM", onStop); // containers / systemd / kill use SIGTERM
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
  const { cmd, args, positionals } = parseArgs(process.argv.slice(2));
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
  if (cmd === "replay") return cmdReplay(args, positionals);
  if (cmd === "show") return cmdShow(args, positionals);
  if (cmd === "signal") return cmdSignal(args, positionals);
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
