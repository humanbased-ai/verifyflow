/**
 * Golden case — Symphony PR #69 ↔ Linear IN-318 ("Add `--version` flag to the `sy` CLI").
 *
 * This is a known-answer accuracy calibration (prd.md success metrics; improvement-directions §5.1.4).
 * It REPLAYS the harness results captured from the real live run (clone + uv sync + execute) through
 * the verdict engine, so it is hermetic and deterministic in CI while still locking in the behavior
 * observed on real execution. The captured report snapshot lives in
 * fixtures/golden/symphony-in-318/expected-report.{md,json}.
 *
 * Ground truth: PR #69 genuinely delivers IN-318. The correct verdict is manual_review_required —
 * AC-1 is proven by execution; AC-2 ("not hardcoded") is an implementation constraint execution
 * cannot prove, so it must be escalated, NOT failed. A `needs_fix` here is a false negative.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideVerdict } from "../core/verdict/engine.js";
import { FallbackLlm } from "../backends/fallbackLlm.js";
import type { CriteriaModel, EvaluationPlan, Evidence, HarnessResult } from "../types.js";

const criteria: CriteriaModel = {
  ticketQualityIssues: [],
  criteria: [
    {
      id: "AC-1",
      text: "`sy --version` prints `Symphony <version>` (e.g. `Symphony 0.1.0`) and exits 0.",
      source: "linear_explicit",
      method: "backend",
      observable: true,
      probe: { command: "sy --version", expectSubstring: "Symphony", expectExitCode: 0, fromTicket: true },
    },
    {
      id: "AC-2",
      text: "Version value is read from the package metadata (`importlib.metadata`) — not hardcoded.",
      source: "linear_explicit",
      method: "backend",
      observable: true,
      // Agent-invented (not quoted in the ticket): corroborating only, never authoritative.
      probe: { command: "uv run test \"$(sy --version)\" = \"Symphony $(python -c '…')\"", fromTicket: false },
    },
  ],
};

const plan: EvaluationPlan = {
  level: "functional",
  notes: [],
  steps: [
    { id: "setup-1", kind: "command", description: "setup", command: "uv sync", criterionIds: [], reusedTestPoint: false },
    { id: "probe-AC-1", kind: "command", description: "probe", command: "uv run sy --version", criterionIds: ["AC-1"], reusedTestPoint: false },
    { id: "probe-AC-2", kind: "command", description: "probe", command: "uv run test …", criterionIds: ["AC-2"], reusedTestPoint: false },
    { id: "tests-scoped", kind: "command", description: "scoped tests", command: 'uv run pytest -q tests/test_cli.py -k "version"', criterionIds: ["AC-1", "AC-2"], reusedTestPoint: false },
  ],
};

const ev = (p: string): Evidence[] => [{ type: "command_output", path: p }];
const hr = (o: Partial<HarnessResult> & { stepId: string }): HarnessResult => ({
  exitCode: 0, stdout: "", stderr: "", durationMs: 10, executed: true, timedOut: false, evidence: [], ...o,
});

// Captured from the real run against the Symphony checkout at 7d7169704629.
const results: HarnessResult[] = [
  hr({ stepId: "setup-1", exitCode: 0 }),
  hr({ stepId: "probe-AC-1", exitCode: 0, stdout: "Symphony 0.1.0\n", evidence: ev("probe-AC-1.log") }),
  hr({ stepId: "probe-AC-2", exitCode: 1, stdout: "", evidence: ev("probe-AC-2.log") }),
  hr({ stepId: "tests-scoped", exitCode: 0, stdout: "1 passed, 59 deselected", evidence: ev("tests-scoped.log") }),
];

test("golden IN-318: AC-1 passes by execution, AC-2 escalates, verdict = manual_review_required", async () => {
  const v = await decideVerdict(criteria, plan, results, new FallbackLlm());

  const ac1 = v.criterionResults.find((c) => c.criterionId === "AC-1");
  const ac2 = v.criterionResults.find((c) => c.criterionId === "AC-2");

  assert.equal(ac1?.result, "pass");
  assert.ok(ac1!.evidence.length > 0, "AC-1 pass must cite evidence");
  assert.equal(ac2?.result, "not_evaluable", "AC-2 must escalate, not fail");

  assert.equal(v.runVerdict, "manual_review_required");
  assert.notEqual(v.runVerdict, "needs_fix"); // the false-negative this case guards against
});
