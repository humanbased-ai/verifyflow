/**
 * IN-792: human false-positive feedback. A criterion a human flagged via `vf feedback` is
 * downgraded from fail/partial to `blocked` (failureCategory flagged_false_positive), so a known
 * misjudgement stops driving the run verdict to needs_fix and becomes manual_review_required.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideVerdict, applyFalsePositiveFeedback } from "./engine.js";
import { matchFeedbackRecords, type FeedbackRecord } from "../../memory/store.js";
import type { LlmClient } from "../../backends/llm.js";
import type { CriteriaModel, CriterionResult, EvaluationPlan, Evidence, HarnessResult } from "../../types.js";

/** No LLM: keep the rule-based verdict so the test is deterministic (the feedback step runs after). */
const noLlm: LlmClient = { name: "none", async available() { return false; }, async complete() { return "{}"; } };

/** A single criterion whose ticket-quoted probe fails non-zero (a real, authoritative `fail`). */
function failingFixture() {
  const criteria = {
    ticketQualityIssues: [],
    criteria: [
      {
        id: "AC-1",
        text: "the export button downloads a CSV of the current view",
        source: "linear_explicit",
        method: "backend",
        observable: true,
        probe: { command: "run-check", fromTicket: true },
      },
    ],
  } as unknown as CriteriaModel;
  const plan = {
    level: "functional",
    notes: [],
    steps: [{ id: "probe-AC-1", kind: "command", description: "probe", command: "run-check", criterionIds: ["AC-1"], reusedTestPoint: false }],
  } as unknown as EvaluationPlan;
  const ev: Evidence[] = [{ type: "command_output", path: "probe-AC-1.log" }];
  const results: HarnessResult[] = [
    { stepId: "probe-AC-1", command: "run-check", exitCode: 1, stdout: "boom: feature not delivered", stderr: "", durationMs: 5, executed: true, timedOut: false, evidence: ev },
  ];
  return { criteria, plan, results };
}

test("baseline: failing authoritative probe → fail → needs_fix", async () => {
  const { criteria, plan, results } = failingFixture();
  const v = await decideVerdict(criteria, plan, results, noLlm);
  assert.equal(v.criterionResults[0]!.result, "fail");
  assert.equal(v.runVerdict, "needs_fix");
});

test("IN-792: a flagged criterion is downgraded fail → blocked → manual_review_required", async () => {
  const { criteria, plan, results } = failingFixture();
  const records: FeedbackRecord[] = [
    { kind: "false_positive", criterionText: "the export button downloads a CSV of the current view", note: "docs-only AC", createdAt: "2026-06-08T00:00:00Z" },
  ];
  const v = await decideVerdict(criteria, plan, results, noLlm, {
    feedbackMatch: (text) => matchFeedbackRecords(records, text),
  });
  const ac1 = v.criterionResults[0]!;
  assert.equal(ac1.result, "blocked");
  assert.equal(ac1.failureCategory, "flagged_false_positive");
  assert.match(ac1.reason, /known false positive via `vf feedback`/);
  assert.match(ac1.reason, /docs-only AC/); // the note is surfaced (auditable)
  assert.equal(v.runVerdict, "manual_review_required");
});

test("IN-792: feedback for a DIFFERENT criterion does not touch this one (fuzzy non-match)", async () => {
  const { criteria, plan, results } = failingFixture();
  const records: FeedbackRecord[] = [
    { kind: "false_positive", criterionText: "the login page validates the password strength meter", createdAt: "2026-06-08T00:00:00Z" },
  ];
  const v = await decideVerdict(criteria, plan, results, noLlm, {
    feedbackMatch: (text) => matchFeedbackRecords(records, text),
  });
  assert.equal(v.criterionResults[0]!.result, "fail", "unrelated feedback must not downgrade");
  assert.equal(v.runVerdict, "needs_fix");
});

test("IN-792: applyFalsePositiveFeedback only touches fail/partial, never pass/blocked/not_evaluable", () => {
  const mk = (id: string, result: CriterionResult["result"]): CriterionResult => ({
    criterionId: id, criterion: `c-${id}`, result, method: "backend", reason: "r", evidence: [], confidence: 0.9,
  });
  const results = [mk("a", "pass"), mk("b", "fail"), mk("c", "partial"), mk("d", "blocked"), mk("e", "not_evaluable")];
  applyFalsePositiveFeedback(results, () => ({})); // matches everything
  assert.deepEqual(results.map((r) => r.result), ["pass", "blocked", "blocked", "blocked", "not_evaluable"]);
  assert.equal(results[1]!.failureCategory, "flagged_false_positive");
  assert.equal(results[2]!.failureCategory, "flagged_false_positive");
});
