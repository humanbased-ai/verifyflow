import path from "node:path";
import type {
  HarnessResult,
  PlanStep,
  QualityEvent,
  RunReport,
  RunRequest,
  RunVerdict,
} from "../types.js";
import type { LlmClient } from "../backends/llm.js";
import type { MemoryStore } from "../memory/store.js";
import type { EventLog } from "../memory/eventLog.js";
import type { GithubClient, PrRef } from "./context/github.js";
import { parsePrRef } from "./context/github.js";
import { type LinearClient, linearKeyFromPr } from "./context/linear.js";
import { parseCriteria } from "./criteria/parser.js";
import { buildPlan } from "./planner/planner.js";
import { loadRepoConfig, type RepoConfig } from "./planner/repoConfig.js";
import { CommandRunner } from "../harness/commandRunner.js";
import { regenerateProbe } from "../harness/probeFix.js";
import { looksLikeHarnessError } from "../util/harnessError.js";
import { decideVerdict } from "./verdict/engine.js";
import { writeReports, type WriteReportResult } from "./reporting/reporter.js";
import { buildImprovementSignal, writeImprovementSignal } from "./reporting/improvementSignal.js";

export interface PipelineDeps {
  linear: LinearClient;
  github: GithubClient;
  llm: LlmClient;
  memory: MemoryStore;
  eventLog: EventLog;
  clock?: () => string;
}

export interface PipelineOutput {
  report: RunReport;
  runDir: string;
  reportPaths: WriteReportResult;
  /** Path to the bounce-back improvement signal, when the PR did not fully deliver (IN-554). */
  signalPath?: string;
}

export async function runVerification(
  req: RunRequest,
  deps: PipelineDeps,
): Promise<PipelineOutput> {
  const now = deps.clock ?? (() => new Date().toISOString());
  const startedAt = now();

  // --- Context: PR is reference, Linear issue is the source of truth -------------------
  const prRef: PrRef = parsePrRef(req.pullRequest);
  const pr = await deps.github.loadPr(prRef);

  const issueKey =
    req.linearIssue && req.linearIssue.trim().length > 0
      ? normalizeIssueKey(req.linearIssue)
      : linearKeyFromPr(pr);
  if (!issueKey) {
    throw new Error(
      "No Linear issue provided and none found in the PR body. VerifyFlow requires a ticket.",
    );
  }
  const issue = await deps.linear.loadIssue(issueKey);

  // --- Criteria (from the issue) + plan ------------------------------------------------
  const criteria = await parseCriteria(issue, pr, deps.llm);
  const cfg = await loadRepoConfig(req.workdir);
  const plan = await buildPlan(req.level, criteria, pr, cfg, deps.memory);

  // --- Real execution ------------------------------------------------------------------
  const runId = `${issue.key}_pr${pr.number}_${startedAt.replace(/[^0-9]/g, "").slice(0, 14)}`;
  const runDir = path.join(req.outputRoot, "runs", runId);
  const artifactRoot = path.join(runDir, "artifacts");

  const results: HarnessResult[] = [];
  if (req.workdir) {
    const runner = new CommandRunner(req.workdir, artifactRoot);
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
      level: req.level,
      backend: req.backend ?? deps.llm.name,
      policy: req.policy,
    },
    issue: { key: issue.key, title: issue.title, url: issue.url, source: issue.source },
    plan,
    criterionResults: verdict.criterionResults,
    runVerdict: verdict.runVerdict,
    summary: verdict.summary,
    ticketQualityIssues: criteria.ticketQualityIssues,
    evidenceRoot: path.relative(req.outputRoot, artifactRoot),
    environment: {
      node: process.version,
      platform: process.platform,
      workdir: req.workdir ?? "(none — no execution)",
      repoConfig: cfg.source,
    },
    startedAt,
    finishedAt,
    durationMs: results.reduce((a, r) => a + r.durationMs, 0),
    gate: gateDecision(req.policy, verdict.runVerdict),
  };

  // --- Quality intelligence: persist memory + events (the "feed test points back" loop) -
  await persistMemoryAndEvents(req, deps, report, criteria, plan, results, component, finishedAt);

  const reportPaths = await writeReports(report, runDir);

  // Bounce-back (IN-554): emit a machine-consumable signal a coding agent can act on.
  const signal = buildImprovementSignal(report, criteria.criteria, results);
  const signalPath = await writeImprovementSignal(signal, runDir);

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
    const fixed = await regenerateProbe({
      criterionText,
      failedCommand: result.command ?? step.command ?? "",
      errorOutput: result.stdout + "\n" + result.stderr,
      cfg,
      llm,
    });
    if (!fixed) break;
    attempt++;
    const retry = await runner.runStep({ ...step, id: `${step.id}-fix${attempt}`, command: fixed });
    result = { ...retry, stepId: step.id }; // canonical id so the verdict engine matches it
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

function gateDecision(policy: RunRequest["policy"], verdict: RunVerdict): RunReport["gate"] {
  if (policy !== "merge_gate") return undefined;
  const blocked = verdict === "needs_fix" || verdict === "manual_review_required";
  return {
    blocked,
    reason: blocked
      ? `policy=merge_gate and verdict=${verdict}`
      : `verdict=${verdict} clears the gate`,
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
