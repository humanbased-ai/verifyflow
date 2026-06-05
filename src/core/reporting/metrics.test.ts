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

// --- IN-625: scope filters + over-time trend ---------------------------------------------

import { filterEvents, computeTrend, renderTrendMarkdown } from "./metrics.js";

const mixed: QualityEvent[] = [
  ev({ criterion_id: "AC-1", result: "pass", repo: "acme/app", level: "functional", ts: "2026-06-01T00:00:00.000Z" }),
  ev({ criterion_id: "AC-2", result: "fail", repo: "acme/app", level: "ui", ts: "2026-06-05T00:00:00.000Z" }),
  ev({ criterion_id: "AC-3", result: "pass", repo: "other/repo", level: "functional", ts: "2026-06-05T00:00:00.000Z" }),
  { event_type: "run_verdict", ts: "2026-06-01T00:00:00.000Z", repo: "acme/app", linear_issue: "EX-1", pr: 1, commit_sha: "a", level: "functional", result: "accept" },
  { event_type: "run_verdict", ts: "2026-06-05T00:00:00.000Z", repo: "acme/app", linear_issue: "EX-2", pr: 2, commit_sha: "b", level: "ui", result: "needs_fix" },
];

test("filterEvents scopes by repo", () => {
  const out = filterEvents(mixed, { repo: "acme/app" });
  assert.ok(out.every((e) => e.repo === "acme/app"));
  assert.equal(out.length, 4);
});

test("filterEvents scopes by level", () => {
  const out = filterEvents(mixed, { level: "ui" });
  assert.ok(out.every((e) => e.level === "ui"));
  assert.equal(out.length, 2);
});

test("filterEvents scopes by since (inclusive lower bound)", () => {
  const out = filterEvents(mixed, { since: "2026-06-03" });
  assert.ok(out.every((e) => Date.parse(e.ts) >= Date.parse("2026-06-03")));
  assert.equal(out.length, 3);
});

test("filterEvents combines filters and ignores an unparsable since", () => {
  assert.equal(filterEvents(mixed, { repo: "acme/app", level: "functional" }).length, 2);
  assert.equal(filterEvents(mixed, { since: "not-a-date" }).length, mixed.length);
});

test("computeTrend buckets run verdicts by day, oldest first", () => {
  const trend = computeTrend(mixed);
  assert.equal(trend.length, 2);
  assert.equal(trend[0]!.date, "2026-06-01");
  assert.equal(trend[0]!.verdicts.accept, 1);
  assert.equal(trend[1]!.date, "2026-06-05");
  assert.equal(trend[1]!.verdicts.needs_fix, 1);
  assert.match(renderTrendMarkdown(trend), /2026-06-05: 1 run/);
});
