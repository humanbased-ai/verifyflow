/**
 * IN-620: a self-check-regenerated probe runs an agent-invented command, so even when the
 * criterion's original probe was ticket-quoted (`fromTicket`), a failure of the regenerated
 * command must NOT become a product `fail` — it is `not_evaluable` ("could not verify").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideVerdict } from "./engine.js";
import type { CriteriaModel, EvaluationPlan, HarnessResult } from "../../types.js";
import type { LlmClient } from "../../backends/llm.js";

const noLlm: LlmClient = { name: "none", available: async () => false, complete: async () => "" };

const criteria: CriteriaModel = {
  ticketQualityIssues: [],
  criteria: [
    {
      id: "AC-1",
      text: "`vf doctor` reports tool readiness",
      source: "linear_explicit",
      method: "backend",
      observable: true,
      probe: { command: "vf doctor", fromTicket: true }, // ticket-quoted → would be authoritative
    },
  ],
};

const plan: EvaluationPlan = {
  level: "functional",
  steps: [{ id: "probe-AC-1", kind: "command", description: "p", command: "vf doctor", criterionIds: ["AC-1"], reusedTestPoint: false }],
  notes: [],
};

function probe(over: Partial<HarnessResult>): HarnessResult {
  return {
    stepId: "probe-AC-1",
    command: "vf doctor",
    exitCode: 1,
    stdout: "",
    stderr: "",
    durationMs: 1,
    executed: true,
    timedOut: false,
    evidence: [],
    ...over,
  };
}

test("regenerated probe failing on a clean (non-harness) error → not_evaluable, never fail", async () => {
  // The regenerated command exited non-zero with output that does NOT look like a harness error,
  // so the only thing stopping a `fail` is the regenerated (non-authoritative) marker.
  const results = [probe({ exitCode: 1, stdout: "some unexpected output", probeRegenerated: true })];
  const out = await decideVerdict(criteria, plan, results, noLlm);
  const r = out.criterionResults[0]!;
  assert.equal(r.result, "not_evaluable", `expected not_evaluable, got ${r.result}`);
  assert.notEqual(out.runVerdict, "needs_fix");
});

test("the SAME failure on the original ticket-quoted probe (not regenerated) is still an authoritative fail", async () => {
  const results = [probe({ exitCode: 1, stdout: "some unexpected output", probeRegenerated: false })];
  const out = await decideVerdict(criteria, plan, results, noLlm);
  assert.equal(out.criterionResults[0]!.result, "fail", "a real ticket-quoted probe failure still fails");
});
