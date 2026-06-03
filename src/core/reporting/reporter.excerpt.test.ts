import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "./reporter.js";
import { buildEvidenceExcerpt } from "../../harness/commandRunner.js";
import type { CriterionResult, RunReport } from "../../types.js";

// IN-579: evidence excerpts travel with the report so the PR comment shows actual output.

function report(criterionResults: CriterionResult[]): RunReport {
  return {
    schemaVersion: 1,
    request: {
      linearIssue: "EX-1",
      pullRequest: "https://github.com/example/greet/pull/7",
      repo: "example/greet",
      prNumber: 7,
      commitSha: "deadbeef",
      level: "functional",
      backend: "fallback",
      policy: "advisory",
    },
    issue: { key: "EX-1", title: "t", url: "u", source: "fixture" },
    plan: { level: "functional", steps: [], notes: [] },
    criterionResults,
    runVerdict: "accept",
    summary: "ok",
    ticketQualityIssues: [],
    evidenceRoot: "runs/x/artifacts",
    environment: {},
    startedAt: "2026-06-03T00:00:00.000Z",
    finishedAt: "2026-06-03T00:00:01.000Z",
    durationMs: 1000,
  };
}

const cr = (id: string, excerpt?: string, path = "probe-AC-1.log"): CriterionResult => ({
  criterionId: id,
  criterion: "c",
  method: "backend",
  result: "pass",
  reason: "r",
  confidence: 0.9,
  evidence: [{ type: "command_output", path, summary: "s", ...(excerpt ? { excerpt } : {}) }],
});

test("buildEvidenceExcerpt: short output passes through whole", () => {
  const e = buildEvidenceExcerpt("$ cmd\n", "hello", "");
  assert.equal(e, "$ cmd\nhello");
});

test("buildEvidenceExcerpt: long output keeps head + tail with truncation marker", () => {
  const e = buildEvidenceExcerpt("$ cmd\n", "A".repeat(5000) + "TAIL_END", "");
  assert.ok(e.length < 1400, `excerpt stays bounded, got ${e.length}`);
  assert.ok(e.startsWith("$ cmd\nAAA"), "head preserved");
  assert.ok(e.endsWith("TAIL_END"), "tail preserved — failures surface at the end");
  assert.match(e, /chars truncated — full log: see artifact/);
});

test("renderMarkdown: excerpts render as collapsed details, deduped by artifact path", () => {
  const md = renderMarkdown(
    report([
      cr("AC-1", "$ cmd\nout-1"),
      cr("AC-2", "$ cmd\nout-1"), // same artifact → one block listing both criteria
      cr("AC-3", "$ other\nout-3", "probe-AC-3.log"),
    ]),
  );
  assert.match(md, /### Evidence excerpts/);
  const blocks = md.match(/<details>/g) ?? [];
  assert.equal(blocks.length, 2, "same artifact path collapses into one block");
  assert.match(md, /<code>probe-AC-1\.log<\/code> — AC-1, AC-2/);
  assert.match(md, /\$ cmd\nout-1/);
});

test("renderMarkdown: no excerpts → no excerpt section; fence breakouts are softened", () => {
  const without = renderMarkdown(report([cr("AC-1")]));
  assert.doesNotMatch(without, /### Evidence excerpts/);

  const hostile = renderMarkdown(report([cr("AC-1", "before\n```\nafter")]));
  assert.doesNotMatch(hostile, /\n```\nafter/, "raw ``` must not escape the fence");
});
