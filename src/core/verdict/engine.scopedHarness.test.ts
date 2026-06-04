/**
 * IN-624: a scoped-tests step that errors with a harness/wrong-ecosystem signature (e.g. the
 * wrong runner — vitest on a node:test repo) must block, not become a product `fail`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideVerdict } from "./engine.js";
import type { CriteriaModel, EvaluationPlan, HarnessResult } from "../../types.js";
import type { LlmClient } from "../../backends/llm.js";

const noLlm: LlmClient = { name: "none", available: async () => false, complete: async () => "" };

// A criterion with NO own probe → the engine falls back to the scoped-tests result.
const criteria: CriteriaModel = {
  ticketQualityIssues: [],
  criteria: [{ id: "AC-1", text: "the feature works", source: "linear_explicit", method: "backend", observable: true }],
};
const plan: EvaluationPlan = {
  level: "functional",
  steps: [{ id: "tests-scoped", kind: "command", description: "scoped", command: "npx vitest run x.test.ts", criterionIds: ["AC-1"], reusedTestPoint: false }],
  notes: [],
};
function scoped(over: Partial<HarnessResult>): HarnessResult {
  return { stepId: "tests-scoped", command: "npx vitest run x.test.ts", exitCode: 1, stdout: "", stderr: "", durationMs: 1, executed: true, timedOut: false, evidence: [], ...over };
}

test("wrong test runner (vitest not found) → blocked, not fail", async () => {
  const out = await decideVerdict(criteria, plan, [scoped({ stderr: "sh: vitest: command not found" })], noLlm);
  assert.equal(out.criterionResults[0]!.result, "blocked");
  assert.notEqual(out.runVerdict, "needs_fix");
});

test("a genuine test failure (no harness signature) still fails", async () => {
  const out = await decideVerdict(criteria, plan, [scoped({ stdout: "1 failing\nAssertionError: expected 2 to equal 3" })], noLlm);
  assert.equal(out.criterionResults[0]!.result, "fail");
});
