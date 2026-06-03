/**
 * IN-556: gate policy modes. A lone not_evaluable (manual_review_required) must not hard-block
 * under the default merge_gate; strict blocks it; advisory never blocks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gateDecision } from "./pipeline.js";
import type { CriterionResult } from "../types.js";

const crits: CriterionResult[] = [
  { criterionId: "AC-1", criterion: "x", result: "pass", method: "backend", reason: "", evidence: [], confidence: 0.92 },
  { criterionId: "AC-2", criterion: "y", result: "not_evaluable", method: "backend", reason: "", evidence: [], confidence: 0.4 },
];

test("advisory never blocks, whatever the verdict", () => {
  assert.equal(gateDecision("advisory", "needs_fix", crits)!.blocked, false);
  assert.equal(gateDecision("advisory", "manual_review_required", crits)!.blocked, false);
});

test("merge_gate blocks needs_fix but NOT manual_review_required (the IN-556 fix)", () => {
  assert.equal(gateDecision("merge_gate", "needs_fix", crits)!.blocked, true);
  assert.equal(gateDecision("merge_gate", "manual_review_required", crits)!.blocked, false);
  assert.equal(gateDecision("merge_gate", "accept", crits)!.blocked, false);
});

test("strict also blocks manual_review_required and accept_with_risks", () => {
  assert.equal(gateDecision("strict", "manual_review_required", crits)!.blocked, true);
  assert.equal(gateDecision("strict", "accept_with_risks", crits)!.blocked, true);
  assert.equal(gateDecision("strict", "accept", crits)!.blocked, false);
});

test("the gate reason surfaces the minimum criterion confidence", () => {
  assert.match(gateDecision("merge_gate", "accept", crits)!.reason, /min criterion confidence 0\.40/);
});
