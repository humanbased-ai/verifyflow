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
import { looksLikeHarnessError } from "../../util/harnessError.js";

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

  // Unknown toolchain (IN-551): nothing could be executed. Report every criterion as
  // environment-blocked with the explicit reason — never a pass or a product fail.
  if (plan.environmentUnknown) {
    const criterionResults = criteria.criteria.map<CriterionResult>((c) => ({
      criterionId: c.id,
      criterion: c.text,
      method: c.method,
      result: "blocked",
      reason: plan.environmentUnknown!.reason,
      evidence: [],
      confidence: 0.5,
      failureCategory: "environment_failure",
    }));
    const runVerdict = rollUp(criterionResults);
    return { criterionResults, runVerdict, summary: buildSummary(criterionResults, runVerdict, plan) };
  }

  const criterionResults: CriterionResult[] = criteria.criteria.map((c) =>
    evaluateCriterion(c, byStep.get(`probe-${c.id}`), scoped, setupFailed),
  );

  if (await llm.available()) {
    try {
      await reviewSubstringMisses(criteria, criterionResults, byStep, llm);
    } catch {
      /* keep the parked not_evaluable when the model is unavailable/unparsable */
    }
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
    if (probe.timedOut) {
      return {
        ...base,
        result: "blocked",
        reason: `Probe \`${probe.command}\` timed out — treated as environment/flake, not a product failure.`,
        evidence: probe.evidence,
        confidence: 0.5,
        failureCategory: "test_flake",
      };
    }
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
    // Triage before judging: a non-zero exit that carries an environment/command-error
    // signature is the harness's own fault (bad probe, wrong interpreter, missing arg), not a
    // product defect. Block it for manual review — never let it become a product `fail`.
    if (!exitOk && looksLikeHarnessError(out)) {
      return {
        ...base,
        result: "blocked",
        reason:
          `Probe \`${probe.command}\` failed with an environment/command error, not a product ` +
          `failure (output shows a usage/spawn/module error). The check could not be executed ` +
          `as intended and needs a corrected probe or manual review.`,
        evidence: probe.evidence,
        confidence: 0.5,
        failureCategory: "environment_failure",
      };
    }
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
    // Only a probe quoted in the ticket is authoritative enough to declare a product failure.
    // An agent-invented probe that fails proves nothing about the product — it could be the
    // probe that is wrong (fragile command, wrong env). Treat that as "could not verify".
    // A self-check-regenerated probe is agent-invented too — its command no longer matches the
    // ticket, so it is never authoritative even when the original probe was (IN-620).
    const authoritative = Boolean(c.probe?.fromTicket) && !probe.probeRegenerated;
    if (!authoritative) {
      return {
        ...base,
        result: "not_evaluable",
        reason: `Agent-constructed check did not pass (${reason}) — this corroborating probe is not authoritative, so the criterion could not be verified by execution and needs manual review.`,
        evidence: probe.evidence,
        confidence: 0.4,
        failureCategory: "insufficient_evidence",
      };
    }
    // Exit 0 but the ticket-derived expected substring missed (IN-545 PR#154 second false-fail
    // form): the command itself SUCCEEDED — only the heuristically-extracted expectation went
    // unmatched, and that extraction can be wrong (e.g. the criterion's second code span is
    // another command name, not an output template). Weak evidence: park as not_evaluable here;
    // `reviewSubstringMisses` resolves it to pass/fail from the actual output when an LLM is
    // available, and without one it stays escalated to a human instead of a false `fail`.
    if (exitOk) {
      return {
        ...base,
        result: "not_evaluable",
        reason:
          `${reason} The command succeeded (exit 0), so the unmatched text may be a ` +
          `mis-extracted expectation rather than a product failure — needs semantic or manual review.`,
        evidence: probe.evidence,
        confidence: 0.45,
        failureCategory: "insufficient_evidence",
      };
    }
    return {
      ...base,
      result: "fail",
      reason,
      evidence: probe.evidence,
      confidence: 0.85,
      failureCategory: "missing_implementation",
    };
  }

  if (scoped) {
    if (scoped.timedOut) {
      return {
        ...base,
        result: "blocked",
        reason: "Scoped tests timed out — treated as environment/flake, not a product failure.",
        evidence: scoped.evidence,
        confidence: 0.5,
        failureCategory: "test_flake",
      };
    }
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
    if (scoped.exitCode === 5) {
      return {
        ...base,
        result: "not_evaluable",
        reason: "No tests matched the selective filter for this criterion.",
        evidence: scoped.evidence,
        confidence: 0.4,
        failureCategory: "insufficient_evidence",
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
    // A scoped test command that errored with a harness/wrong-ecosystem signature (e.g. the
    // wrong runner — `vitest` on a `node --test` repo) means the check could not run, not that
    // the product failed. Block for review instead of a false `fail` (IN-624).
    if (looksLikeHarnessError(scoped.stdout + "\n" + scoped.stderr)) {
      return {
        ...base,
        result: "blocked",
        reason: "Scoped tests errored with an environment/command signature (likely the wrong test runner), not a product failure — needs a corrected runner or manual review.",
        evidence: scoped.evidence,
        confidence: 0.5,
        failureCategory: "environment_failure",
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

/**
 * Semantic resolution of exit-0 substring misses (IN-545 PR#154 false-fail fix).
 *
 * A ticket-derived probe that exited 0 but missed its heuristically-extracted expected
 * substring was parked as `not_evaluable` by the rules. This focused, per-criterion review
 * hands the ACTUAL output and the criterion text to the LLM: a clear demonstration upgrades
 * to `pass` (capped confidence — the evidence is the real output, the call only reads it),
 * a clear violation lands `fail` (the probe is authoritative: ticket-quoted, executed, no
 * harness-error signature). No parsable signal → stays parked for a human.
 */
async function reviewSubstringMisses(
  criteria: CriteriaModel,
  results: CriterionResult[],
  byStep: Map<string, HarnessResult>,
  llm: LlmClient,
): Promise<void> {
  for (const c of criteria.criteria) {
    if (!c.probe?.fromTicket || !c.probe.expectSubstring) continue;
    const probe = byStep.get(`probe-${c.id}`);
    if (!probe || !probe.executed || probe.timedOut || probe.exitCode !== 0) continue;
    const out = probe.stdout + "\n" + probe.stderr;
    if (out.includes(c.probe.expectSubstring)) continue;
    const r = results.find((x) => x.criterionId === c.id);
    if (!r || r.result !== "not_evaluable") continue;

    const system =
      "You are VerifyFlow's semantic output reviewer. A probe command ran successfully " +
      "(exit 0) but its output did not contain a heuristically-extracted expected substring — " +
      "that extraction is often wrong (e.g. it may be another command name from the criterion " +
      "text, not an output template). Decide from the ACTUAL OUTPUT whether the acceptance " +
      "criterion is satisfied. Be skeptical: satisfied=true only when the output clearly " +
      'demonstrates the criterion. JSON only: {"satisfied": true|false, "reason": "..."}.';
    const prompt = [
      `Acceptance criterion: ${c.text}`,
      `Probe command: ${probe.command}`,
      `Heuristic expected substring (possibly mis-extracted): "${c.probe.expectSubstring}"`,
      "Actual output:",
      out.slice(0, 1500),
    ].join("\n");
    const raw = await llm.complete({ system, prompt, task: "substring-semantic-review", tier: "fast" });
    const parsed = extractJson<{ satisfied?: boolean; reason?: string }>(raw);
    if (parsed.satisfied === true) {
      r.result = "pass";
      r.confidence = 0.78;
      r.failureCategory = undefined;
      r.reason =
        `Ran \`${probe.command}\`: exit 0. Expected-substring heuristic missed, but semantic ` +
        `review of the actual output confirms the criterion${parsed.reason ? `: ${parsed.reason}` : "."}`;
    } else if (parsed.satisfied === false) {
      r.result = "fail";
      r.confidence = 0.8;
      r.failureCategory = "backend_functionality";
      r.reason =
        `Ran \`${probe.command}\`: exit 0, but semantic review of the actual output finds the ` +
        `criterion NOT satisfied${parsed.reason ? `: ${parsed.reason}` : "."}`;
    }
    // No parsable signal (e.g. deterministic fallback returns {}): stays not_evaluable.
  }
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
    "do not punish the PR with `fail` for something that is simply unprovable by execution. " +
    "Use `partial` when the evidence shows the criterion is only PARTIALLY satisfied or works only " +
    "in limited conditions — more delivered than not, but not a clean full pass (e.g. the happy " +
    "path works but a stated edge/error case does not). Reserve `partial` for softening an " +
    "over-optimistic `pass`; never use it to soften a genuine violation, which stays `fail`. " +
    "CRITICAL: command/usage/environment errors (e.g. 'unrecognized arguments', argparse 'usage:' " +
    "dumps, 'No module named', 'command not found', 'Failed to spawn') mean the PROBE or its " +
    "environment is broken — NOT the product. Never base a `fail` on such output; that output is " +
    "evidence the check did not run as intended, not evidence the PR is wrong. JSON only.";
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

  // A criterion may only be downgraded to `fail` by the reviewer when there is a clean,
  // authoritative refutation: a ticket-quoted probe that actually executed and did NOT error
  // with an environment/command-error signature. Otherwise the reviewer is reasoning over a
  // broken probe (IN-545 regression) — cap any such `fail` at `not_evaluable`.
  const byStepId = new Map(harness.map((h) => [h.stepId, h]));
  const canFail = (id: string): boolean => {
    const c = criteria.criteria.find((x) => x.id === id);
    if (!c?.probe?.fromTicket) return false;
    const probe = byStepId.get(`probe-${id}`);
    if (!probe || !probe.executed) return false;
    // A regenerated probe ran an agent-invented command, not the ticket's — not authoritative (IN-620).
    if (probe.probeRegenerated) return false;
    if (looksLikeHarnessError(probe.stdout + "\n" + probe.stderr)) return false;
    return true;
  };

  const raw = await llm.complete({ system, prompt, task: "verdict-review", tier: "smart" });
  const parsed = extractJson<{ adjustments?: LlmVerdictAdj[] }>(raw);
  for (const adj of parsed.adjustments ?? []) {
    const r = results.find((x) => x.criterionId === adj.id);
    if (!r || !adj.downgradeTo) continue;
    if (adj.downgradeTo === "fail" && !canFail(adj.id)) {
      // Reviewer wanted a product failure off a non-authoritative/broken probe — refuse it.
      adj.downgradeTo = "not_evaluable";
    }
    if (rank[adj.downgradeTo] < rank[r.result]) {
      r.result = adj.downgradeTo;
      if (adj.reason) r.reason = `${r.reason} [reviewer: ${adj.reason}]`;
      r.confidence = Math.min(r.confidence, 0.8);
      if (adj.downgradeTo === "fail" && !r.failureCategory)
        r.failureCategory = "backend_functionality";
    }
  }
}
