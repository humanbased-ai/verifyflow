import path from "node:path";
import type {
  CriteriaModel,
  CriterionResult,
  EvaluationPlan,
  HarnessResult,
  IssueContext,
  PlanStep,
  PrContext,
  QualityEvent,
  RunReport,
  RunRequest,
  RunVerdict,
} from "../types.js";
import { type UiHarness, UnavailableUiHarness } from "../harness/ui/uiHarness.js";
import { runUiChecks } from "../harness/ui/runUiChecks.js";
import { type JourneyHarness, UnavailableJourneyHarness } from "../harness/journey/journeyHarness.js";
import { runJourneyChecks } from "../harness/journey/runJourneyChecks.js";
import type { LlmClient } from "../backends/llm.js";
import type { MemoryStore } from "../memory/store.js";
import type { EventLog } from "../memory/eventLog.js";
import type { GithubClient, PrRef } from "./context/github.js";
import { parsePrRef } from "./context/github.js";
import { type LinearClient, linearKeyFromPr } from "./context/linear.js";
import { parseCriteria } from "./criteria/parser.js";
import { buildPlan } from "./planner/planner.js";
import { selectLevel } from "./planner/selectLevel.js";
import { loadRepoConfig, type RepoConfig } from "./planner/repoConfig.js";
import { CommandRunner } from "../harness/commandRunner.js";
import { regenerateProbe } from "../harness/probeFix.js";
import { looksLikeHarnessError } from "../util/harnessError.js";
import { decideVerdict } from "./verdict/engine.js";
import { writeVerdictInputs } from "./verdict/replay.js";
import { writeReports, type WriteReportResult } from "./reporting/reporter.js";
import { buildImprovementSignal, writeImprovementSignal } from "./reporting/improvementSignal.js";

export interface PipelineDeps {
  linear: LinearClient;
  github: GithubClient;
  llm: LlmClient;
  memory: MemoryStore;
  eventLog: EventLog;
  clock?: () => string;
  /** UI execution backend for level=ui (IN-559). Defaults to UnavailableUiHarness. */
  uiHarness?: UiHarness;
  /**
   * Builds the UI harness once the run's artifact dir is known, so browser evidence
   * (screenshots) lands under the same artifact root as command evidence (IN-606). Takes
   * precedence over `uiHarness` when provided.
   */
  uiHarnessFactory?: (artifactRoot: string) => UiHarness;
  /** Journey execution backend for level=journey (IN-659). Defaults to UnavailableJourneyHarness. */
  journeyHarness?: JourneyHarness;
  /** Builds the journey harness once the artifact dir is known (mirrors uiHarnessFactory). */
  journeyHarnessFactory?: (artifactRoot: string) => JourneyHarness;
}

export interface PipelineOutput {
  report: RunReport;
  runDir: string;
  reportPaths: WriteReportResult;
  /** Path to the bounce-back improvement signal, when the PR did not fully deliver (IN-554). */
  signalPath?: string;
}

/**
 * Resolve the run context: load the PR (reference) and the Linear issue (source of truth),
 * applying degraded no-ticket mode (IN-570). Shared by `runVerification` and `planRun`.
 */
async function resolveContext(
  req: RunRequest,
  deps: PipelineDeps,
): Promise<{ pr: PrContext; issue: IssueContext; degraded: boolean }> {
  const prRef: PrRef = parsePrRef(req.pullRequest);
  const pr = await deps.github.loadPr(prRef);

  const issueKey =
    req.linearIssue && req.linearIssue.trim().length > 0
      ? normalizeIssueKey(req.linearIssue)
      : linearKeyFromPr(pr);
  // Degraded no-ticket mode (IN-570): the PR's own title/description stands in for the
  // ticket. That is the PR grading its own homework, so the verdict is capped later.
  const degraded = !issueKey && req.allowNoTicket === true;
  if (!issueKey && !degraded) {
    throw new Error(
      "No Linear issue provided and none found in the PR body or branch name. VerifyFlow " +
        "requires a ticket — or pass --allow-no-ticket to verify against the PR's own " +
        "description (verdict capped at manual_review_required).",
    );
  }
  const issue: IssueContext = degraded
    ? {
        key: `PR-${pr.number}`,
        title: pr.title,
        description: pr.body,
        url: pr.url,
        source: "pr-degraded",
      }
    : await deps.linear.loadIssue(issueKey!);
  return { pr, issue, degraded };
}

/**
 * Build the evaluation plan for a level WITHOUT executing it. For ui level this also stamps the
 * criteria with ui-check probes and returns the harness so execution can reuse it; for functional
 * it returns the resolved repo config the execution loop needs. Pure planning — no subprocesses.
 */
async function buildEvaluationPlan(
  req: RunRequest,
  deps: PipelineDeps,
  criteria: CriteriaModel,
  pr: PrContext,
  // The artifact root for an executing harness, or `undefined` for plan-only mode (`--dry-run`):
  // no probes/tests run, so no execution harness is constructed and nothing touches the filesystem.
  artifactRoot?: string,
): Promise<{
  plan: EvaluationPlan;
  repoConfigSource: string;
  ui?: UiHarness;
  journey?: JourneyHarness;
  cfg?: RepoConfig;
}> {
  if (req.level === "journey") {
    // Journey level: multi-step end-to-end checks (IN-659). The executor is a backend behind the
    // JourneyHarness seam; until it is wired (Phase 2 / IN-661) the default reports checks as not
    // executed → criteria block, never falsely pass. Mirrors the ui branch below, including the
    // plan-only guard: in --dry-run we never execute, so we must NOT construct a real harness.
    const journey =
      artifactRoot === undefined
        ? undefined
        : deps.journeyHarnessFactory?.(artifactRoot) ?? deps.journeyHarness ?? new UnavailableJourneyHarness();
    const harnessName = journey?.name ?? deps.journeyHarness?.name ?? "journey harness";
    for (const c of criteria.criteria) {
      if (c.observable) c.probe = { command: `journey-check: ${c.text}`, fromTicket: true };
    }
    const plan: EvaluationPlan = {
      level: "journey",
      steps: criteria.criteria
        .filter((c) => c.observable)
        .map((c) => ({
          id: `probe-${c.id}`,
          kind: "inspect",
          description: `journey check for ${c.id}`,
          criterionIds: [c.id],
          reusedTestPoint: false,
        })),
      notes: [`journey level: multi-step end-to-end checks via ${harnessName}`],
    };
    return { plan, repoConfigSource: "n/a", journey };
  }
  if (req.level === "ui") {
    // UI level: browser-driven checks (IN-559). The browser is an execution backend behind the
    // UiHarness seam; until a real driver is wired the default reports checks as not executed.
    // In plan-only mode we never execute, so we must NOT construct a real driver — its constructor
    // may have filesystem side effects (e.g. creating `<artifactRoot>/artifacts`).
    const ui =
      artifactRoot === undefined
        ? undefined
        : deps.uiHarnessFactory?.(artifactRoot) ?? deps.uiHarness ?? new UnavailableUiHarness();
    const harnessName = ui?.name ?? deps.uiHarness?.name ?? "browser harness";
    // UI checks are judged by the browser (pass/fail), not by stdout. Replace any command-probe
    // a criterion picked up with a clean ui marker so the engine scores exit 0 = pass / 1 = fail
    // and never compares against a stdout substring meant for a CLI probe.
    for (const c of criteria.criteria) {
      if (c.observable) c.probe = { command: `ui-check: ${c.text}`, fromTicket: true };
    }
    const plan: EvaluationPlan = {
      level: "ui",
      steps: criteria.criteria
        .filter((c) => c.observable)
        .map((c) => ({
          id: `probe-${c.id}`,
          kind: "inspect",
          description: `ui check for ${c.id}`,
          criterionIds: [c.id],
          reusedTestPoint: false,
        })),
      notes: [`ui level: browser-driven checks via ${harnessName}`],
    };
    return { plan, repoConfigSource: "n/a", ui };
  }
  const cfg = await loadRepoConfig(req.workdir);
  const plan = await buildPlan(req.level, criteria, pr, cfg, deps.memory);
  return { plan, repoConfigSource: cfg.source, cfg };
}

export interface PlanPreview {
  pr: PrContext;
  issue: IssueContext;
  criteria: CriteriaModel;
  plan: EvaluationPlan;
  degraded: boolean;
}

/**
 * Resolve context + parse criteria + build the plan, and stop — `vf run --dry-run` (IN-625).
 * Executes no probes/tests, performs no checkout, writes nothing. Lets a user inspect "how would
 * VerifyFlow verify this?" for free before paying for a real run.
 */
export async function planRun(req: RunRequest, deps: PipelineDeps): Promise<PlanPreview> {
  const { pr, issue, degraded } = await resolveContext(req, deps);
  const criteria = await parseCriteria(issue, pr, deps.llm);
  const sel = req.autoSelect ? selectLevel(criteria, pr, req.autoSelect) : undefined;
  const eff = sel ? { ...req, level: sel.level } : req;
  // Plan-only: no run dir, no artifact root — buildEvaluationPlan constructs no execution harness.
  const { plan } = await buildEvaluationPlan(eff, deps, criteria, pr);
  if (sel) plan.notes.unshift(...sel.notes);
  return { pr, issue, criteria, plan, degraded };
}

export async function runVerification(
  req: RunRequest,
  deps: PipelineDeps,
): Promise<PipelineOutput> {
  const now = deps.clock ?? (() => new Date().toISOString());
  const startedAt = now();

  // --- Context: PR is reference, Linear issue is the source of truth -------------------
  const { pr, issue, degraded } = await resolveContext(req, deps);

  // --- Criteria (from the issue) ------------------------------------------------------
  const criteria = await parseCriteria(issue, pr, deps.llm);

  // --- Auto level (IN-680): resolve `--level auto` now that the criteria exist ---------
  const sel = req.autoSelect ? selectLevel(criteria, pr, req.autoSelect) : undefined;
  const eff = sel ? { ...req, level: sel.level } : req;

  const runId = `${issue.key}_pr${pr.number}_${startedAt.replace(/[^0-9]/g, "").slice(0, 14)}`;
  const runDir = path.join(req.outputRoot, "runs", runId);
  const artifactRoot = path.join(runDir, "artifacts");

  // --- Plan + real execution (level-specific) -----------------------------------------
  const { plan, repoConfigSource, ui, journey, cfg } = await buildEvaluationPlan(
    eff,
    deps,
    criteria,
    pr,
    artifactRoot,
  );
  if (sel) plan.notes.unshift(...sel.notes);
  const results: HarnessResult[] = [];

  if (eff.level === "journey") {
    // buildEvaluationPlan always returns a defined `journey` for level=journey (it constructs the
    // executor or an UnavailableJourneyHarness itself), so the non-null assertion is the invariant.
    results.push(...(await runJourneyChecks(journey!, criteria, eff.baseUrl)));
  } else if (eff.level === "ui") {
    // buildEvaluationPlan always returns a defined `ui` for level=ui (it constructs the driver or
    // an UnavailableUiHarness itself), so the non-null assertion is the real invariant here.
    results.push(...(await runUiChecks(ui!, criteria, eff.baseUrl)));
  } else if (eff.workdir) {
    // buildEvaluationPlan always returns a cfg for non-UI levels today. Fail loudly rather than
    // silently skipping execution if a future level ever omits it.
    if (!cfg) {
      throw new Error(
        `internal: no repo config resolved for level "${req.level}"; cannot execute probes`,
      );
    }
    const runner = new CommandRunner(eff.workdir, artifactRoot, { isolate: eff.sandbox !== false });
    for (const step of plan.steps) {
      if (step.id.startsWith("probe-")) {
        const criterionText = criteria.criteria.find((c) => c.id === step.criterionIds[0])?.text;
        results.push(await runProbeWithSelfCheck(runner, step, criterionText, cfg, deps.llm));
      } else {
        results.push(await runner.runStep(step));
      }
      // Stop spending on probes/tests if environment setup failed hard.
      if (step.id.startsWith("setup-")) {
        const last = results[results.length - 1]!;
        if (!last.executed || last.exitCode !== 0) break;
      }
    }
  }

  // --- Verdict -------------------------------------------------------------------------
  const verdict = await decideVerdict(criteria, plan, results, deps.llm);

  // Degraded cap (IN-570): without an independent acceptance source, a positive outcome
  // can only mean "the PR does what it claims" — escalate to a human instead of accepting.
  // A demonstrated failure (needs_fix) is kept: failing your own claims needs no ticket.
  let runVerdict = verdict.runVerdict;
  let summary = verdict.summary;
  const ticketQualityIssues = [...criteria.ticketQualityIssues];
  if (degraded) {
    ticketQualityIssues.push(
      "⚠️ degraded run: no Linear ticket — acceptance criteria derived from the PR's own " +
        "description (no independent acceptance source); verdict capped at manual_review_required.",
    );
    if (runVerdict === "accept" || runVerdict === "accept_with_risks") {
      summary = `No independent acceptance source (verdict capped from ${runVerdict}): ${summary}`;
      runVerdict = "manual_review_required";
    }
  }

  const finishedAt = now();
  const commitSha = pr.headSha || req.commitSha || "";
  const component = deriveComponent(pr);

  const report: RunReport = {
    schemaVersion: 1,
    request: {
      linearIssue: issue.key,
      pullRequest: pr.url,
      repo: pr.repo,
      prNumber: pr.number,
      commitSha,
      level: eff.level,
      backend: req.backend ?? deps.llm.name,
      policy: req.policy,
    },
    issue: { key: issue.key, title: issue.title, url: issue.url, source: issue.source },
    plan,
    criterionResults: verdict.criterionResults,
    runVerdict,
    summary,
    ticketQualityIssues,
    evidenceRoot: path.relative(req.outputRoot, artifactRoot),
    environment: {
      node: process.version,
      platform: process.platform,
      workdir: req.workdir ?? "(none — no execution)",
      repoConfig: repoConfigSource,
      ...(req.crosscheckVerdict ? { crosscheckVerdict: req.crosscheckVerdict } : {}),
    },
    startedAt,
    finishedAt,
    durationMs: results.reduce((a, r) => a + r.durationMs, 0),
    gate: gateDecision(req.policy, runVerdict, verdict.criterionResults),
  };

  // --- Quality intelligence: persist memory + events (the "feed test points back" loop) -
  await persistMemoryAndEvents(eff, deps, report, criteria, plan, results, component, finishedAt);

  // Build the bounce-back signal (IN-554) up front — it is pure — so all three run-dir artifacts
  // are written together. Issuing them concurrently means no single write is gated behind another
  // succeeding, so a failure can't leave report.md present but verdict-inputs.json /
  // improvement-signal.json missing (IN-625 review).
  const signal = buildImprovementSignal(report, criteria.criteria, results);
  const [reportPaths, , signalPath] = await Promise.all([
    writeReports(report, runDir),
    // Persist the verdict engine's inputs so `vf replay <runId>` can re-derive the verdict from
    // stored evidence without re-executing any probe/test (IN-625).
    writeVerdictInputs({ criteria, plan, results }, runDir),
    writeImprovementSignal(signal, runDir),
  ]);

  return { report, runDir, reportPaths, signalPath };
}

/**
 * Run a probe, and if it fails with an environment/command-error signature (our probe is
 * broken, not the product — IN-545/IN-552), ask the LLM to regenerate a corrected probe and
 * re-run it, up to `maxRetries` times. Each retry runs under a suffixed step id so its log is
 * preserved as evidence; the returned result carries the canonical `probe-<id>` so the verdict
 * engine still matches it to the criterion. Without a real LLM (fallback) nothing is repaired.
 */
export async function runProbeWithSelfCheck(
  runner: CommandRunner,
  step: PlanStep,
  criterionText: string | undefined,
  cfg: RepoConfig,
  llm: LlmClient,
  maxRetries = 2,
): Promise<HarnessResult> {
  let result = await runner.runStep(step);
  let attempt = 0;
  while (
    attempt < maxRetries &&
    criterionText &&
    result.executed &&
    result.exitCode !== 0 &&
    looksLikeHarnessError(result.stdout + "\n" + result.stderr)
  ) {
    // The regeneration calls the LLM; a transient model error must not crash the whole run
    // (it would surface as a non-zero `vf step` exit and silently block an orchestrator's
    // merge gate). On any failure, stop self-healing and keep the original result.
    let fixed: string | undefined;
    try {
      fixed = await regenerateProbe({
        criterionText,
        failedCommand: result.command ?? step.command ?? "",
        errorOutput: result.stdout + "\n" + result.stderr,
        cfg,
        llm,
      });
    } catch {
      break;
    }
    if (!fixed) break;
    attempt++;
    const retry = await runner.runStep({ ...step, id: `${step.id}-fix${attempt}`, command: fixed });
    // Canonical id so the verdict engine matches it; mark regenerated so the engine treats this
    // agent-invented command as non-authoritative (its failure can't become a product fail, IN-620).
    result = { ...retry, stepId: step.id, probeRegenerated: true };
  }
  return result;
}

function normalizeIssueKey(input: string): string {
  const url = input.match(/issue\/([A-Z]+-\d+)/i);
  if (url) return url[1]!.toUpperCase();
  return input.trim().toUpperCase();
}

function deriveComponent(pr: { changedFiles: { path: string }[] }): string {
  const first = pr.changedFiles[0]?.path;
  if (!first) return "unknown";
  const parts = first.split("/");
  return parts.length > 1 ? parts.slice(0, 2).join("/") : parts[0]!;
}

/**
 * Decide the merge gate from the policy (IN-556).
 *  - advisory: never blocks.
 *  - merge_gate: blocks only on `needs_fix` — a positively-demonstrated product failure. A lone
 *    `not_evaluable` (manual_review_required) no longer hard-blocks here.
 *  - strict: also blocks on `manual_review_required` and `accept_with_risks`.
 * The lowest per-criterion confidence is surfaced in the reason so reviewers see how sure the
 * verdict is without it changing the block decision.
 */
export function gateDecision(
  policy: RunRequest["policy"],
  verdict: RunVerdict,
  criterionResults: CriterionResult[] = [],
): RunReport["gate"] {
  const minConfidence = criterionResults.length
    ? Math.min(...criterionResults.map((c) => c.confidence))
    : undefined;
  const confNote = minConfidence !== undefined ? ` (min criterion confidence ${minConfidence.toFixed(2)})` : "";

  if (policy === "advisory") {
    return { blocked: false, reason: `advisory: verdict=${verdict} — reporting only, never blocks${confNote}` };
  }
  const blocked =
    verdict === "needs_fix" ||
    (policy === "strict" && (verdict === "manual_review_required" || verdict === "accept_with_risks"));
  return {
    blocked,
    reason: blocked
      ? `policy=${policy} blocks on verdict=${verdict}${confNote}`
      : `policy=${policy}: verdict=${verdict} clears the gate${confNote}`,
  };
}

async function persistMemoryAndEvents(
  req: RunRequest,
  deps: PipelineDeps,
  report: RunReport,
  criteria: Awaited<ReturnType<typeof parseCriteria>>,
  plan: RunReport["plan"],
  results: HarnessResult[],
  component: string,
  now: string,
): Promise<void> {
  const ranById = new Map(results.map((r) => [r.stepId, r]));
  const events: QualityEvent[] = [];

  for (const cr of report.criterionResults) {
    const criterion = criteria.criteria.find((c) => c.id === cr.criterionId);
    // Feed test points back: persist any probe we actually executed so future runs reuse it.
    if (criterion?.probe && ranById.get(`probe-${cr.criterionId}`)?.executed) {
      await deps.memory.upsertTestPoint({
        repo: report.request.repo,
        component,
        criterionText: criterion.text,
        method: criterion.method,
        probe: criterion.probe,
        result: cr.result,
        now,
      });
    }
    if (cr.failureCategory && (cr.result === "fail" || cr.result === "blocked")) {
      await deps.memory.recordFailureMode(report.request.repo, cr.failureCategory, component, now);
    }
    events.push({
      event_type: "acceptance_criterion_result",
      ts: now,
      repo: report.request.repo,
      linear_issue: report.issue.key,
      pr: report.request.prNumber,
      commit_sha: report.request.commitSha,
      level: req.level,
      criterion_id: cr.criterionId,
      result: cr.result,
      failure_category: cr.failureCategory,
      component,
      duration_ms: ranById.get(`probe-${cr.criterionId}`)?.durationMs,
      is_flaky_suspected: false,
      reused: plan.steps.find((s) => s.id === `probe-${cr.criterionId}`)?.reusedTestPoint ?? false,
    });
  }
  events.push({
    event_type: "run_verdict",
    ts: now,
    repo: report.request.repo,
    linear_issue: report.issue.key,
    pr: report.request.prNumber,
    commit_sha: report.request.commitSha,
    level: req.level,
    result: report.runVerdict,
    component,
    duration_ms: report.durationMs,
  });
  await deps.eventLog.appendMany(events);
}
