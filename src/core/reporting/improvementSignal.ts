import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  Criterion,
  HarnessResult,
  ImprovementItem,
  ImprovementSeverity,
  ImprovementSignal,
  RunReport,
} from "../../types.js";

const SEVERITY: Record<string, ImprovementSeverity> = {
  fail: "must_fix",
  partial: "must_fix",
  blocked: "investigate",
  not_evaluable: "needs_clarification",
};

/** A criterion result is actionable for bounce-back when it is anything other than a clean pass. */
function isActionable(result: string): boolean {
  return result in SEVERITY;
}

function expectedFor(criterion: Criterion | undefined, fallbackText: string): string {
  const probe = criterion?.probe;
  if (!probe) return fallbackText;
  const parts = [`\`${probe.command}\``, `exit ${probe.expectExitCode ?? 0}`];
  if (probe.expectSubstring) parts.push(`output contains "${probe.expectSubstring}"`);
  return parts.join(" → ");
}

function observedFor(probe: HarnessResult | undefined, reason: string): string {
  if (!probe) return reason;
  const out = (probe.stdout + (probe.stderr ? `\n${probe.stderr}` : "")).trim();
  return `exit ${probe.exitCode}${out ? `; ${out.slice(0, 400)}` : ""}`;
}

/**
 * Build a structured improvement signal from a finished run. Returns undefined when every
 * criterion passed (nothing to bounce back). `criteria`/`results` provide the probe command and
 * raw execution output that the prose report summarizes.
 */
export function buildImprovementSignal(
  report: RunReport,
  criteria: Criterion[],
  results: HarnessResult[],
): ImprovementSignal | undefined {
  const byCriterion = new Map(criteria.map((c) => [c.id, c]));
  const byStep = new Map(results.map((r) => [r.stepId, r]));

  const items: ImprovementItem[] = report.criterionResults
    .filter((cr) => isActionable(cr.result))
    .map((cr) => {
      const criterion = byCriterion.get(cr.criterionId);
      const probe = byStep.get(`probe-${cr.criterionId}`);
      return {
        criterionId: cr.criterionId,
        criterion: cr.criterion,
        result: cr.result,
        severity: SEVERITY[cr.result]!,
        failureCategory: cr.failureCategory,
        expected: expectedFor(criterion, cr.criterion),
        observed: observedFor(probe, cr.reason),
        probeCommand: probe?.command ?? criterion?.probe?.command,
        evidence: cr.evidence.map((e) => e.path ?? e.ref ?? e.type),
      };
    });

  if (items.length === 0) return undefined;
  return {
    schemaVersion: 1,
    repo: report.request.repo,
    prNumber: report.request.prNumber,
    commitSha: report.request.commitSha,
    linearIssue: report.issue.key,
    verdict: report.runVerdict,
    items,
  };
}

/** Write the signal to <runDir>/improvement-signal.json. Returns the path, or undefined if none. */
export async function writeImprovementSignal(
  signal: ImprovementSignal | undefined,
  runDir: string,
): Promise<string | undefined> {
  if (!signal) return undefined;
  await fs.mkdir(runDir, { recursive: true });
  const p = path.join(runDir, "improvement-signal.json");
  await fs.writeFile(p, JSON.stringify(signal, null, 2) + "\n");
  return p;
}
