/**
 * VerifyFlow shared types.
 *
 * These mirror the contracts in docs/evidence-schema.md, prd.md and architecture.md.
 * The core primitive is:  Linear ticket + GitHub PR + level -> evidence-backed delivery verdict.
 *
 * VerifyFlow is a DELIVERY verification agent. It judges whether the PR delivers the
 * intent + acceptance criteria of the linked Linear issue. It is NOT a code-review/bug tool.
 */

export type Level = "functional" | "ui" | "journey";
export type Policy = "advisory" | "merge_gate";

/** Criterion-level verdicts (docs/evidence-schema.md). */
export type CriterionResultValue =
  | "pass"
  | "fail"
  | "partial"
  | "blocked"
  | "not_evaluable";

/** Run-level verdicts (prd.md). */
export type RunVerdict =
  | "accept"
  | "accept_with_risks"
  | "needs_fix"
  | "manual_review_required";

export type EvidenceType =
  | "command_output"
  | "test_report"
  | "api_response"
  | "database_assertion"
  | "screenshot"
  | "video"
  | "browser_trace"
  | "console_log"
  | "network_log"
  | "device_log"
  | "ci_artifact"
  | "environment_metadata";

export interface Evidence {
  type: EvidenceType;
  /** Relative path under the artifact root, when the evidence is a stored file. */
  path?: string;
  /** Short human description of what this evidence shows. */
  summary?: string;
  /** External reference (URL) when the evidence lives elsewhere (e.g. CI artifact). */
  ref?: string;
}

/** Normalized invocation request produced by every trigger adapter. */
export interface RunRequest {
  linearIssue: string; // issue key (IN-318) or URL
  pullRequest: string; // PR URL or "owner/repo#123"
  commitSha?: string;
  level: Level;
  backend?: string;
  policy: Policy;
  /** When set, read fixtures instead of hitting live gh/Linear/claude. */
  fixtureDir?: string;
  /** Working directory containing a checkout of the target repo (live runs). */
  workdir?: string;
  /** Where artifacts, reports, events and memory are written. */
  outputRoot: string;
}

/** Linear issue context — the PRIMARY source of truth for acceptance criteria. */
export interface IssueContext {
  key: string;
  title: string;
  description: string;
  url: string;
  status?: string;
  /** "linear-api" | "linear-mcp" | "fixture" | "manual" */
  source: string;
}

export interface ChangedFile {
  path: string;
  additions?: number;
  deletions?: number;
}

/** GitHub PR context — REFERENCE ONLY. Used to see what was changed/claimed, never as the criteria source. */
export interface PrContext {
  repo: string; // owner/repo
  number: number;
  url: string;
  title: string;
  body: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  additions: number;
  deletions: number;
  changedFiles: ChangedFile[];
  /** Unified diff text (may be truncated for large PRs). */
  diff: string;
  source: string;
}

/** How a criterion is most plausibly checked. */
export type CriterionMethod = "backend" | "ui" | "integration" | "journey";

/**
 * A directly runnable probe derived from a criterion (e.g. AC "sy --version prints X" ->
 * run `sy --version` and assert stdout contains "Symphony"). Probes are the reusable
 * "test points" that get persisted to memory and fed back on later runs.
 */
export interface Probe {
  command: string;
  expectExitCode?: number;
  expectSubstring?: string;
  /** cwd relative to the target checkout root. */
  cwd?: string;
  /**
   * True when the command was quoted in the ticket itself (authoritative — its failure is a
   * real product `fail`). False/undefined for agent-invented probes, which only corroborate:
   * a pass is evidence, but a failure means "could not verify", not "violated".
   */
  fromTicket?: boolean;
}

export interface Criterion {
  id: string; // AC-1, AC-2, ...
  text: string; // exact text quoted from the ticket when explicit (no-guess)
  /** Where this criterion came from. Explicit ticket criteria outrank inferred ones. */
  source: "linear_explicit" | "linear_implicit" | "pr_inferred";
  method: CriterionMethod;
  /** False when the criterion is too vague/contradictory/unobservable to evaluate. */
  observable: boolean;
  probe?: Probe;
  notes?: string;
}

export interface CriteriaModel {
  criteria: Criterion[];
  /** Ticket-quality problems surfaced during parsing (drives quality intelligence). */
  ticketQualityIssues: string[];
}

export interface PlanStep {
  id: string;
  kind: "command" | "inspect";
  description: string;
  command?: string;
  cwd?: string;
  criterionIds: string[];
  expectSubstring?: string;
  expectExitCode?: number;
  /** True when this step was reused from a persisted memory test point. */
  reusedTestPoint: boolean;
}

export interface EvaluationPlan {
  level: Level;
  steps: PlanStep[];
  notes: string[];
  /** Recommended escalation when risk exceeds the requested level (docs/evaluation-levels.md). */
  escalationRecommended?: { toLevel: Level; reason: string };
}

export interface HarnessResult {
  stepId: string;
  command?: string;
  cwd?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** True when the step ran to completion (regardless of pass/fail); false on env/spawn failure. */
  executed: boolean;
  /** True when the step was killed for exceeding its time budget (treated as environment/flake, not product fail). */
  timedOut: boolean;
  evidence: Evidence[];
}

export interface CriterionResult {
  criterionId: string;
  criterion: string;
  result: CriterionResultValue;
  method: string;
  reason: string;
  evidence: Evidence[];
  confidence: number;
  failureCategory?: FailureCategory;
}

export type FailureCategory =
  | "missing_implementation"
  | "backend_functionality"
  | "ui_behavior"
  | "ui_backend_integration"
  | "downstream_integration"
  | "auth_or_permission"
  | "migration_or_data"
  | "test_flake"
  | "environment_failure"
  | "ambiguous_ticket"
  | "insufficient_evidence";

export interface RunReport {
  schemaVersion: 1;
  request: {
    linearIssue: string;
    pullRequest: string;
    repo: string;
    prNumber: number;
    commitSha: string;
    level: Level;
    backend: string;
    policy: Policy;
  };
  issue: { key: string; title: string; url: string; source: string };
  plan: EvaluationPlan;
  criterionResults: CriterionResult[];
  runVerdict: RunVerdict;
  summary: string;
  ticketQualityIssues: string[];
  evidenceRoot: string;
  environment: Record<string, string>;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** Merge-gate decision when policy === "merge_gate". */
  gate?: { blocked: boolean; reason: string };
}

/** Structured event appended to the JSONL quality-intelligence log. */
export interface QualityEvent {
  event_type: string;
  ts: string;
  repo: string;
  linear_issue: string;
  pr: number;
  commit_sha: string;
  level: Level;
  criterion_id?: string;
  result?: CriterionResultValue | RunVerdict;
  failure_category?: FailureCategory;
  component?: string;
  duration_ms?: number;
  is_flaky_suspected?: boolean;
}

/**
 * Bounce-back improvement signal (IN-554): a machine-consumable artifact emitted when a PR
 * does not fully deliver its ticket, so a coding agent (Crosscheck/Symphony) can ingest it and
 * dispatch a fix — instead of a human re-reading prose. One item per non-passing criterion.
 */
export type ImprovementSeverity = "must_fix" | "investigate" | "needs_clarification";

export interface ImprovementItem {
  criterionId: string;
  criterion: string;
  result: CriterionResultValue;
  severity: ImprovementSeverity;
  failureCategory?: FailureCategory;
  /** What the criterion required (probe expectation or, absent a probe, the criterion text). */
  expected: string;
  /** What execution actually showed (probe exit/output, or the verdict reason). */
  observed: string;
  /** The exact probe command run, when there was one. */
  probeCommand?: string;
  /** Evidence artifact paths supporting this item. */
  evidence: string[];
}

export interface ImprovementSignal {
  schemaVersion: 1;
  repo: string;
  prNumber: number;
  commitSha: string;
  linearIssue: string;
  verdict: RunVerdict;
  items: ImprovementItem[];
}

/** A persisted, reusable test point (Karpathy: keep memory, not just a score). */
export interface TestPoint {
  id: string;
  repo: string;
  component: string;
  criterionText: string;
  method: CriterionMethod;
  probe: Probe;
  lastResult?: CriterionResultValue;
  runs: number;
  createdAt: string;
  updatedAt: string;
}
