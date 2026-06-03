/**
 * Regression — Symphony PR #154 ↔ Linear IN-545 ("Add `symphony info` command").
 *
 * Dogfood finding: VerifyFlow returned a FALSE `needs_fix` on a PR that actually delivers the
 * ticket. Root cause was twofold and is what this test locks down:
 *   1. The agent-generated probes errored at the *command* level (a malformed `uv run d=$(…)`
 *      that ran the system `symphony` and printed argparse "unrecognized arguments"; a
 *      `python3 -m pytest` with "No module named pytest"). Those are harness/environment
 *      errors, not product failures.
 *   2. The LLM verdict reviewer then "downgraded" AC-7 from not_evaluable to `fail`, reasoning
 *      over that broken probe's output as if it were a real violation.
 *
 * Ground truth: PR #154 delivers IN-545. A `needs_fix` driven by broken probes is a false
 * negative. This test REPLAYS the captured buggy harness outputs through the verdict engine —
 * including an adversarial reviewer that tries to force a `fail` — and asserts the guards hold.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideVerdict } from "../core/verdict/engine.js";
import type { LlmClient } from "../backends/llm.js";
import type { CriteriaModel, EvaluationPlan, Evidence, HarnessResult } from "../types.js";

// AC-7: "workflow_path is overridable via a positional argument" — agent-invented probe.
const criteria: CriteriaModel = {
  ticketQualityIssues: [],
  criteria: [
    {
      id: "AC-7",
      text: "The workflow file path is overridable via a positional workflow_path argument, defaulting to ./WORKFLOW.md.",
      source: "linear_explicit",
      method: "backend",
      observable: true,
      // Agent-invented (not quoted in the ticket): corroborating only, never authoritative.
      probe: { command: 'uv run d=$(mktemp -d); symphony info "$d/WORKFLOW.md" --json | python3 -c "…"', fromTicket: false },
    },
  ],
};

const plan: EvaluationPlan = {
  level: "functional",
  notes: [],
  steps: [
    { id: "setup-1", kind: "command", description: "setup", command: "uv sync", criterionIds: [], reusedTestPoint: false },
    { id: "probe-AC-7", kind: "command", description: "probe", command: criteria.criteria[0]!.probe!.command, criterionIds: ["AC-7"], reusedTestPoint: false },
  ],
};

const ev = (p: string): Evidence[] => [{ type: "command_output", path: p }];

// Captured verbatim from the real run (.verifyflow/runs/IN-545_pr154_*/artifacts/probe-AC-7.log).
const results: HarnessResult[] = [
  { stepId: "setup-1", exitCode: 0, stdout: "", stderr: "", durationMs: 10, executed: true, timedOut: false, evidence: [] },
  {
    stepId: "probe-AC-7",
    command: plan.steps[1]!.command,
    exitCode: 1,
    stdout: "",
    stderr:
      "error: Failed to spawn: `d=/var/folders/T/tmp.GpzxtogcIK`\n" +
      "usage: symphony [-h] [--version] [workflow_path]\n" +
      "symphony: error: unrecognized arguments: /WORKFLOW.md --json",
    durationMs: 10,
    executed: true,
    timedOut: false,
    evidence: ev("probe-AC-7.log"),
  },
];

// Adversarial reviewer: tries to do exactly what the real model did — call the broken probe a
// "provable violation" and force a fail. The guard must refuse it.
const adversarialLlm: LlmClient = {
  name: "adversarial-stub",
  available: async () => true,
  complete: async () =>
    JSON.stringify({
      adjustments: [{ id: "AC-7", downgradeTo: "fail", reason: "unrecognized arguments proves info has no positional" }],
    }),
};

test("regression IN-545: a broken probe is triaged, never scored as a product fail", async () => {
  const v = await decideVerdict(criteria, plan, results, adversarialLlm);
  const ac7 = v.criterionResults.find((c) => c.criterionId === "AC-7");

  assert.notEqual(ac7?.result, "fail", "AC-7 must NOT be a product fail — its probe errored at the command level");
  assert.equal(ac7?.result, "blocked", "a command/usage error is an environment failure, not a product defect");
  assert.equal(ac7?.failureCategory, "environment_failure");
  assert.notEqual(v.runVerdict, "needs_fix", "the false negative this case guards against");
  assert.equal(v.runVerdict, "manual_review_required");
});
