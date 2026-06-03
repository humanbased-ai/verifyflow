/**
 * Regression — Symphony PR #154 ↔ IN-545, second false-fail form (2026-06-03 live run).
 *
 * The criterion "A `sy info` alias invokes the same command as `symphony info`." made the
 * ticket-probe heuristic extract command=`sy info` and expectSubstring="symphony info" — but
 * that second code span is ANOTHER COMMAND NAME, not an output template. The probe ran
 * perfectly (exit 0, correct diagnostics output), yet the substring miss was scored as a hard
 * product `fail` → false `needs_fix` on a delivering PR.
 *
 * Locked-down behavior: exit-0 substring miss on a ticket-derived probe is weak evidence —
 * parked as not_evaluable; an LLM semantic review of the actual output resolves it to
 * pass/fail; without a usable LLM signal it stays escalated to a human. A non-zero exit on a
 * ticket probe still fails hard (unchanged).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideVerdict } from "./engine.js";
import { FallbackLlm } from "../../backends/fallbackLlm.js";
import type { LlmClient, LlmRequest } from "../../backends/llm.js";
import type { CriteriaModel, EvaluationPlan, Evidence, HarnessResult } from "../../types.js";

const REAL_OUTPUT =
  "Symphony 0.1.0 — Python 3.12.13 on darwin\n" +
  "Workflow: /tmp/x/WORKFLOW.md\nRunner:   claude_code\nTracker:  linear";

function fixtures(exitCode = 0, stdout = REAL_OUTPUT) {
  const criteria: CriteriaModel = {
    ticketQualityIssues: [],
    criteria: [
      {
        id: "AC-7",
        text: "A `sy info` alias invokes the same command as `symphony info`.",
        source: "linear_explicit",
        method: "backend",
        observable: true,
        // Ticket-derived probe; second code span mis-extracted as the expected output.
        probe: { command: "uv run sy info", expectSubstring: "symphony info", fromTicket: true },
      },
    ],
  };
  const plan: EvaluationPlan = {
    level: "functional",
    notes: [],
    steps: [
      { id: "probe-AC-7", kind: "command", description: "probe", command: "uv run sy info", criterionIds: ["AC-7"], reusedTestPoint: false },
    ],
  };
  const ev: Evidence[] = [{ type: "command_output", path: "probe-AC-7.log" }];
  const results: HarnessResult[] = [
    { stepId: "probe-AC-7", command: "uv run sy info", exitCode, stdout, stderr: "", durationMs: 50, executed: true, timedOut: false, evidence: ev },
  ];
  return { criteria, plan, results };
}

/** LLM stub: answers the semantic review; stays silent for the verdict reviewer. */
function semanticLlm(satisfied: boolean): LlmClient {
  return {
    name: "stub",
    async available() {
      return true;
    },
    async complete(req: LlmRequest) {
      if (req.task === "substring-semantic-review") {
        return JSON.stringify({ satisfied, reason: satisfied ? "alias output matches symphony info diagnostics" : "output shows the wrong command ran" });
      }
      return "{}";
    },
  };
}

test("exit-0 substring miss without LLM signal: parked as not_evaluable, never a fail", async () => {
  const { criteria, plan, results } = fixtures();
  const verdict = await decideVerdict(criteria, plan, results, new FallbackLlm());
  const ac7 = verdict.criterionResults[0]!;
  assert.equal(ac7.result, "not_evaluable");
  assert.match(ac7.reason, /mis-extracted|semantic or manual review/);
  assert.equal(verdict.runVerdict, "manual_review_required"); // not a false needs_fix
});

test("exit-0 substring miss + semantic review confirms: pass (the PR#154 ground truth)", async () => {
  const { criteria, plan, results } = fixtures();
  const verdict = await decideVerdict(criteria, plan, results, semanticLlm(true));
  const ac7 = verdict.criterionResults[0]!;
  assert.equal(ac7.result, "pass");
  assert.ok(ac7.confidence <= 0.8, "semantic-confirmed pass carries capped confidence");
  assert.match(ac7.reason, /semantic review/);
  assert.equal(verdict.runVerdict, "accept");
});

test("exit-0 substring miss + semantic review refutes: fail stands", async () => {
  const { criteria, plan, results } = fixtures();
  const verdict = await decideVerdict(criteria, plan, results, semanticLlm(false));
  const ac7 = verdict.criterionResults[0]!;
  assert.equal(ac7.result, "fail");
  assert.equal(ac7.failureCategory, "backend_functionality");
  assert.equal(verdict.runVerdict, "needs_fix");
});

test("non-zero exit on a ticket probe still fails hard (unchanged behavior)", async () => {
  const { criteria, plan, results } = fixtures(1, "boom: assertion failed");
  const verdict = await decideVerdict(criteria, plan, results, new FallbackLlm());
  const ac7 = verdict.criterionResults[0]!;
  assert.equal(ac7.result, "fail");
  assert.equal(verdict.runVerdict, "needs_fix");
});
