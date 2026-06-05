/**
 * IN-665: the `partial` criterion verdict is reachable. The verdict reviewer may downgrade an
 * over-optimistic `pass` to `partial` (criterion only partially satisfied / limited conditions),
 * which rolls up to the run-level `accept_with_risks`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideVerdict } from "./engine.js";
import { FallbackLlm } from "../../backends/fallbackLlm.js";
import type { LlmClient, LlmRequest } from "../../backends/llm.js";
import type { CriteriaModel, EvaluationPlan, Evidence, HarnessResult } from "../../types.js";

function fixtures() {
  const criteria: CriteriaModel = {
    ticketQualityIssues: [],
    criteria: [
      {
        id: "AC-1",
        text: "the export button downloads a CSV of the current view",
        source: "linear_explicit",
        method: "backend",
        observable: true,
        probe: { command: "echo ok", expectSubstring: "ok", fromTicket: true },
      },
    ],
  } as unknown as CriteriaModel;
  const plan: EvaluationPlan = {
    level: "functional",
    notes: [],
    steps: [
      { id: "probe-AC-1", kind: "command", description: "probe", command: "echo ok", criterionIds: ["AC-1"], reusedTestPoint: false },
    ],
  } as unknown as EvaluationPlan;
  const ev: Evidence[] = [{ type: "command_output", path: "probe-AC-1.log" }];
  const results: HarnessResult[] = [
    { stepId: "probe-AC-1", command: "echo ok", exitCode: 0, stdout: "ok", stderr: "", durationMs: 5, executed: true, timedOut: false, evidence: ev },
  ];
  return { criteria, plan, results };
}

/** LLM stub: the verdict reviewer downgrades the rule-based pass to `partial`. */
function partialReviewer(): LlmClient {
  return {
    name: "stub",
    async available() {
      return true;
    },
    async complete(req: LlmRequest) {
      if (req.task === "verdict-review") {
        return JSON.stringify({
          adjustments: [{ id: "AC-1", downgradeTo: "partial", reason: "CSV exports, but only the current page, not the full view" }],
        });
      }
      return "{}";
    },
  };
}

test("baseline: rule-based pass with no reviewer signal → pass → accept", async () => {
  const { criteria, plan, results } = fixtures();
  const verdict = await decideVerdict(criteria, plan, results, new FallbackLlm());
  assert.equal(verdict.criterionResults[0]!.result, "pass");
  assert.equal(verdict.runVerdict, "accept");
});

test("IN-665: reviewer downgrades pass → partial → run verdict accept_with_risks", async () => {
  const { criteria, plan, results } = fixtures();
  const verdict = await decideVerdict(criteria, plan, results, partialReviewer());
  const ac1 = verdict.criterionResults[0]!;
  assert.equal(ac1.result, "partial");
  assert.match(ac1.reason, /reviewer:.*current page/);
  assert.equal(verdict.runVerdict, "accept_with_risks");
});
