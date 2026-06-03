import path from "node:path";
import type { CriterionResultValue, RunReport, RunVerdict } from "../types.js";

/**
 * Machine-readable result of a `vf step` run (IN-569), printed as a single JSON line on
 * stdout for the orchestrator (Symphony) to consume. Everything human-facing goes to stderr.
 */
export interface StepSummary {
  schemaVersion: 1;
  issue: string;
  repo: string;
  prNumber: number;
  commitSha: string;
  verdict: RunVerdict;
  /** Phase 1 is advisory-only: the step never blocks; this is always false. */
  gateBlocked: boolean;
  criteria: Record<CriterionResultValue, number>;
  runId: string;
  reportJson: string;
  reportMarkdown: string;
  /** Bounce-back signal path (IN-554), present when the PR did not fully deliver. */
  improvementSignal?: string;
  prCommentPosted: boolean;
}

export function buildStepSummary(opts: {
  report: RunReport;
  runDir: string;
  reportJsonPath: string;
  reportMarkdownPath: string;
  signalPath?: string;
  prCommentPosted: boolean;
}): StepSummary {
  const counts: Record<CriterionResultValue, number> = {
    pass: 0,
    fail: 0,
    partial: 0,
    blocked: 0,
    not_evaluable: 0,
  };
  for (const c of opts.report.criterionResults) counts[c.result] += 1;
  return {
    schemaVersion: 1,
    issue: opts.report.issue.key,
    repo: opts.report.request.repo,
    prNumber: opts.report.request.prNumber,
    commitSha: opts.report.request.commitSha,
    verdict: opts.report.runVerdict,
    gateBlocked: opts.report.gate?.blocked ?? false,
    criteria: counts,
    runId: path.basename(opts.runDir),
    reportJson: opts.reportJsonPath,
    reportMarkdown: opts.reportMarkdownPath,
    ...(opts.signalPath ? { improvementSignal: opts.signalPath } : {}),
    prCommentPosted: opts.prCommentPosted,
  };
}
