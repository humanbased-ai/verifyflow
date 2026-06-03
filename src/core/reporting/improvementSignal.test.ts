/**
 * IN-554: a non-passing run emits a structured, per-criterion bounce-back signal a coding
 * agent can act on; an all-pass run emits nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildImprovementSignal } from "./improvementSignal.js";
import type { Criterion, HarnessResult, RunReport } from "../../types.js";

const criteria: Criterion[] = [
  {
    id: "AC-1",
    text: "`sy doctor` exits 0",
    source: "linear_explicit",
    method: "backend",
    observable: true,
    probe: { command: "sy doctor", expectExitCode: 0, fromTicket: true },
  },
  {
    id: "AC-2",
    text: "`sy --version` prints Symphony",
    source: "linear_explicit",
    method: "backend",
    observable: true,
    probe: { command: "sy --version", expectSubstring: "Symphony", fromTicket: true },
  },
];

const results: HarnessResult[] = [
  { stepId: "probe-AC-1", command: "uv run sy doctor", exitCode: 3, stdout: "config invalid", stderr: "", durationMs: 5, executed: true, timedOut: false, evidence: [] },
  { stepId: "probe-AC-2", command: "uv run sy --version", exitCode: 0, stdout: "Symphony 0.1.0", stderr: "", durationMs: 5, executed: true, timedOut: false, evidence: [] },
];

function report(overrides: Partial<RunReport["criterionResults"]> = {}): RunReport {
  return {
    request: { repo: "acme/app", prNumber: 7, commitSha: "abc123", linearIssue: "EX-1", level: "functional", backend: "x", policy: "merge_gate" },
    issue: { key: "EX-1", title: "t", url: "u", source: "fixture" },
    runVerdict: "needs_fix",
    criterionResults: [
      { criterionId: "AC-1", criterion: criteria[0]!.text, result: "fail", method: "backend", reason: "exited 3", evidence: [{ type: "command_output", path: "probe-AC-1.log" }], confidence: 0.85, failureCategory: "missing_implementation" },
      { criterionId: "AC-2", criterion: criteria[1]!.text, result: "pass", method: "backend", reason: "ok", evidence: [], confidence: 0.92 },
    ],
    ...overrides,
  } as unknown as RunReport;
}

test("a failing criterion produces one actionable signal item with expected/observed/evidence", () => {
  const signal = buildImprovementSignal(report(), criteria, results);
  assert.ok(signal);
  assert.equal(signal!.items.length, 1, "only the non-passing criterion is included");
  const item = signal!.items[0]!;
  assert.equal(item.criterionId, "AC-1");
  assert.equal(item.severity, "must_fix");
  assert.equal(item.failureCategory, "missing_implementation");
  assert.match(item.expected, /sy doctor/);
  assert.match(item.observed, /exit 3/);
  assert.match(item.observed, /config invalid/);
  assert.equal(item.probeCommand, "uv run sy doctor");
  assert.deepEqual(item.evidence, ["probe-AC-1.log"]);
});

test("an all-pass run produces no signal (nothing to bounce back)", () => {
  const allPass = report({
    criterionResults: [
      { criterionId: "AC-2", criterion: "x", result: "pass", method: "backend", reason: "ok", evidence: [], confidence: 0.92 },
    ],
  } as unknown as Partial<RunReport["criterionResults"]>);
  assert.equal(buildImprovementSignal(allPass, criteria, results), undefined);
});
