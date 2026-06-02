import type {
  CriteriaModel,
  CriterionResult,
  CriterionResultValue,
  EvaluationPlan,
  FailureCategory,
  HarnessResult,
  RunVerdict,
} from "../../types.js";
import type { LlmClient } from "../../backends/llm.js";
import { extractJson } from "../../util/json.js";

export interface VerdictOutput {
  criterionResults: CriterionResult[];
  runVerdict: RunVerdict;
  summary: string;
}

/**
 * Assigns criterion-level and run-level verdicts from harness evidence.
 *
 * Hard rules (docs/evidence-schema.md, prd.md):
 *  - never mark a criterion `pass` without evidence;
 *  - separate product failure / environment failure / ambiguity / insufficient evidence;
 *  - the LLM may only DOWNGRADE a rule-derived pass (skeptical direction) — it can never
 *    upgrade a fail/blocked to pass, so evidence stays the ground truth.
 */
export async function decideVerdict(
  criteria: CriteriaModel,
  plan: EvaluationPlan,
  results: HarnessResult[],
  llm: LlmClient,
): Promise<VerdictOutput> {
  const byStep = new Map(results.map((r) => [r.stepId, r]));
  const setupFailed = plan.steps
    .filter((s) => s.id.startsWith("setup-"))
    .some((s) => {
      const r = byStep.get(s.id);
      return r && (!r.executed || r.exitCode !== 0);
    });

  const scoped = byStep.get("tests-scoped");

  const criterionResults: CriterionResult[] = criteria.criteria.map((c) =>
    evaluateCriterion(c, byStep.get(`probe-${c.id}`), scoped, setupFailed),
  );

  if (await llm.available()) {
    try {
      await applyLlmJudgment(criteria, criterionResults, results, llm);
    } catch {
      /* keep rule-based results when the model is unavailable/unparsable */
    }
  }

  const runVerdict = rollUp(criterionResults);
  const summary = buildSummary(criterionResults, runVerdict, plan);
  return { criterionResults, runVerdict, summary };
}

function evaluateCriterion(
  c: CriteriaModel["criteria"][number],
  probe: HarnessResult | undefined,
  scoped: HarnessResult | undefined,
  setupFailed: boolean,
): CriterionResult {
  const base = {
    criterionId: c.id,
    criterion: c.text,
    method: c.method,
  };

  if (!c.observable) {
    return {
      ...base,
      result: "not_evaluable",
      reason: "Criterion is too vague/unobservable to evaluate from the ticket.",
      evidence: [],
      confidence: 0.4,
      failureCategory: "ambiguous_ticket",
    };
  }

  if (setupFailed) {
    return {
      ...base,
      result: "blocked",
      reason: "Environment setup failed; could not execute checks for this criterion.",
      evidence: [],
      confidence: 0.5,
      failureCategory: "environment_failure",
    };
  }

  // Prefer the criterion's own probe; fall back to scoped tests.
  if (probe) {
    if (!probe.executed) {
      return {
        ...base,
        result: "blocked",
        reason: `Probe command could not be executed (${probe.command}).`,
        evidence: probe.evidence,
        confidence: 0.5,
        failureCategory: "environment_failure",
      };
    }
    const out = probe.stdout + "\n" + probe.stderr;
    const exitOk = probe.exitCode === 0;
    const substrOk = !probeExpectsSubstring(c) || out.includes(c.probe!.expectSubstring!);
    if (exitOk && substrOk) {
      return {
        ...base,
        result: "pass",
        reason: `Ran \`${probe.command}\`: exit 0${
          probeExpectsSubstring(c) ? ` and output contains "${c.probe!.expectSubstring}"` : ""
        }.`,
        evidence: probe.evidence,
        confidence: 0.92,
      };
    }
    const reason = !exitOk
      ? `Ran \`${probe.command}\`: exited ${probe.exitCode} (expected 0).`
      : `Ran \`${probe.command}\`: output did not contain expected "${c.probe!.expectSubstring}".`;
    return {
      ...base,
      result: "fail",
      reason,
      evidence: probe.evidence,
      confidence: 0.85,
      failureCategory: exitOk ? "backend_functionality" : "missing_implementation",
    };
  }

  if (scoped) {
    if (!scoped.executed) {
      return {
        ...base,
        result: "blocked",
        reason: "Scoped tests could not be executed.",
        evidence: scoped.evidence,
        confidence: 0.5,
        failureCategory: "environment_failure",
      };
    }
    if (scoped.exitCode === 0) {
      return {
        ...base,
        result: "pass",
        reason: "Covered by the PR's changed tests, which pass.",
        evidence: scoped.evidence,
        confidence: 0.7,
      };
    }
    return {
      ...base,
      result: "fail",
      reason: "The PR's changed tests fail.",
      evidence: scoped.evidence,
      confidence: 0.75,
      failureCategory: "backend_functionality",
    };
  }

  return {
    ...base,
    result: "not_evaluable",
    reason: "No runnable probe and no changed tests cover this criterion.",
    evidence: [],
    confidence: 0.3,
    failureCategory: "insufficient_evidence",
  };
}

function probeExpectsSubstring(c: CriteriaModel["criteria"][number]): boolean {
  return Boolean(c.probe?.expectSubstring);
}

function rollUp(results: CriterionResult[]): RunVerdict {
  const has = (v: CriterionResultValue) => results.some((r) => r.result === v);
  if (has("fail")) return "needs_fix";
  if (has("blocked")) return "manual_review_required";
  if (has("not_evaluable")) return "manual_review_required";
  if (has("partial")) return "accept_with_risks";
  return "accept";
}

function buildSummary(
  results: CriterionResult[],
  verdict: RunVerdict,
  plan: EvaluationPlan,
): string {
  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.result] = (acc[r.result] ?? 0) + 1;
    return acc;
  }, {});
  const parts = Object.entries(counts).map(([k, v]) => `${v} ${k}`);
  let s = `Delivery verdict: ${verdict}. ${results.length} criteria (${parts.join(", ")}).`;
  if (plan.escalationRecommended) {
    s += ` Escalation recommended to ${plan.escalationRecommended.toLevel}: ${plan.escalationRecommended.reason}.`;
  }
  return s;
}

interface LlmVerdictAdj {
  id: string;
  downgradeTo?: CriterionResultValue; // only honored if it is a downgrade
  reason?: string;
}

async function applyLlmJudgment(
  criteria: CriteriaModel,
  results: CriterionResult[],
  harness: HarnessResult[],
  llm: LlmClient,
): Promise<void> {
  const rank: Record<CriterionResultValue, number> = {
    pass: 4,
    partial: 3,
    not_evaluable: 2,
    blocked: 1,
    fail: 0,
  };
  const system =
    "You are VerifyFlow's verdict reviewer. You judge whether each acceptance criterion is " +
    "DELIVERED based ONLY on the provided execution evidence. You may downgrade an over-optimistic " +
    "verdict; you must NEVER upgrade toward pass, and never claim a pass without evidence. " +
    "Crucial distinction: use `fail` ONLY when the evidence positively shows the criterion is " +
    "VIOLATED. When the evidence merely does not PROVE the criterion (e.g. an implementation " +
    "constraint like 'not hardcoded' that execution cannot demonstrate), use `not_evaluable` — " +
    "do not punish the PR with `fail` for something that is simply unprovable by execution. JSON only.";
  const evidenceExcerpts = harness.map((h) => ({
    step: h.stepId,
    command: h.command,
    exit: h.exitCode,
    out: (h.stdout + h.stderr).slice(0, 800),
  }));
  const prompt = [
    "Criteria + current rule-based verdicts:",
    JSON.stringify(
      results.map((r) => ({ id: r.criterionId, text: r.criterion, result: r.result })),
      null,
      2,
    ),
    "",
    "Execution evidence:",
    JSON.stringify(evidenceExcerpts, null, 2),
    "",
    'Respond: {"adjustments":[{"id","downgradeTo","reason"}]}. Only include criteria you would change.',
  ].join("\n");

  const raw = await llm.complete({ system, prompt, task: "verdict-review" });
  const parsed = extractJson<{ adjustments?: LlmVerdictAdj[] }>(raw);
  for (const adj of parsed.adjustments ?? []) {
    const r = results.find((x) => x.criterionId === adj.id);
    if (!r || !adj.downgradeTo) continue;
    if (rank[adj.downgradeTo] < rank[r.result]) {
      r.result = adj.downgradeTo;
      if (adj.reason) r.reason = `${r.reason} [reviewer: ${adj.reason}]`;
      r.confidence = Math.min(r.confidence, 0.8);
      if (adj.downgradeTo === "fail" && !r.failureCategory)
        r.failureCategory = "backend_functionality";
    }
  }
}
