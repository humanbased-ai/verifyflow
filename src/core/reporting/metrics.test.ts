/**
 * IN-557: aggregate the event log into quality-intelligence metrics.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMetrics, renderMetricsMarkdown } from "./metrics.js";
import type { QualityEvent } from "../../types.js";

const ev = (o: Partial<QualityEvent>): QualityEvent => ({
  event_type: "acceptance_criterion_result",
  ts: "2026-06-03T00:00:00.000Z",
  repo: "acme/app",
  linear_issue: "EX-1",
  pr: 1,
  commit_sha: "abc",
  level: "functional",
  ...o,
});

const events: QualityEvent[] = [
  ev({ criterion_id: "AC-1", result: "pass", component: "cli", duration_ms: 10, reused: true }),
  ev({ criterion_id: "AC-2", result: "fail", component: "cli", failure_category: "missing_implementation", duration_ms: 80 }),
  ev({ criterion_id: "AC-3", result: "not_evaluable", component: "api", duration_ms: 5 }),
  ev({ criterion_id: "AC-4", result: "fail", component: "cli", failure_category: "missing_implementation", duration_ms: 20 }),
  { event_type: "run_verdict", ts: "x", repo: "acme/app", linear_issue: "EX-1", pr: 1, commit_sha: "abc", level: "functional", result: "needs_fix" },
];

test("computes pass / not-evaluable / reuse rates over criterion events", () => {
  const m = computeMetrics(events);
  assert.equal(m.criteria, 4);
  assert.equal(m.runs, 1);
  assert.equal(m.passRate, 0.25); // 1/4
  assert.equal(m.notEvaluableRate, 0.25); // 1/4
  assert.equal(m.reuseRate, 0.25); // 1/4
  assert.equal(m.verdicts.needs_fix, 1);
});

test("aggregates failures by component/category and flags repeated patterns", () => {
  const m = computeMetrics(events);
  assert.equal(m.failuresByComponent.cli, 2);
  assert.equal(m.failuresByCategory.missing_implementation, 2);
  assert.equal(m.repeatedFailurePatterns[0]?.component, "cli");
  assert.equal(m.repeatedFailurePatterns[0]?.count, 2);
});

test("slowest harness is ranked first; markdown renders without throwing", () => {
  const m = computeMetrics(events);
  assert.equal(m.slowest[0]?.criterionId, "AC-2"); // 80ms
  assert.match(renderMetricsMarkdown(m), /pass rate: 25\.0%/);
});

test("empty event log yields zeroed metrics, not a crash", () => {
  const m = computeMetrics([]);
  assert.equal(m.criteria, 0);
  assert.equal(m.passRate, 0);
});
