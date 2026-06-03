import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildStepSummary, type StepSummary } from "./step.js";
import type { RunReport } from "../types.js";

const exec = promisify(execFile);
const repoRoot = process.cwd();

function fakeReport(over: Partial<RunReport> = {}): RunReport {
  return {
    schemaVersion: 1,
    request: {
      linearIssue: "EX-1",
      pullRequest: "https://github.com/example/greet/pull/7",
      repo: "example/greet",
      prNumber: 7,
      commitSha: "deadbeefcafe0000",
      level: "functional",
      backend: "fallback",
      policy: "advisory",
    },
    issue: { key: "EX-1", title: "t", url: "u", source: "fixture" },
    plan: { level: "functional", steps: [], notes: [] },
    criterionResults: [
      { criterionId: "AC-1", criterion: "a", result: "pass", confidence: 0.9, method: "probe", evidence: [], reason: "" },
      { criterionId: "AC-2", criterion: "b", result: "pass", confidence: 0.9, method: "probe", evidence: [], reason: "" },
      { criterionId: "AC-3", criterion: "c", result: "not_evaluable", confidence: 0.5, method: "inspect", evidence: [], reason: "" },
    ],
    runVerdict: "accept",
    summary: "ok",
    ticketQualityIssues: [],
    evidenceRoot: "runs/x/artifacts",
    environment: {},
    startedAt: "2026-06-03T00:00:00.000Z",
    finishedAt: "2026-06-03T00:00:01.000Z",
    durationMs: 1000,
    gate: { blocked: false, reason: "advisory" },
    ...over,
  } as RunReport;
}

test("buildStepSummary: counts criteria, never blocks, omits absent signal", () => {
  const s = buildStepSummary({
    report: fakeReport(),
    runDir: "/tmp/out/runs/EX-1_pr7_20260603000000",
    reportJsonPath: "/tmp/out/runs/EX-1_pr7_20260603000000/report.json",
    reportMarkdownPath: "/tmp/out/runs/EX-1_pr7_20260603000000/report.md",
    prCommentPosted: true,
  });
  assert.equal(s.issue, "EX-1");
  assert.equal(s.verdict, "accept");
  assert.equal(s.gateBlocked, false);
  assert.deepEqual(s.criteria, { pass: 2, fail: 0, partial: 0, blocked: 0, not_evaluable: 1 });
  assert.equal(s.runId, "EX-1_pr7_20260603000000");
  assert.ok(!("improvementSignal" in s));
  assert.equal(s.prCommentPosted, true);
});

test("e2e: vf step prints exactly one JSON line on stdout and exits 0 (advisory)", async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "vf-step-"));
  const { stdout } = await exec(
    process.execPath,
    [
      "--import", "tsx",
      "src/cli/main.ts",
      "step",
      "--fixtures", "fixtures/example-cli",
      "--pr", "https://github.com/example/greet/pull/7",
      "--workdir", "examples/example-target",
      "--out", out,
      "--crosscheck-verdict", "APPROVE",
    ],
    { cwd: repoRoot },
  );

  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 1, `stdout must be a single JSON line, got: ${stdout}`);
  const summary = JSON.parse(lines[0]!) as StepSummary;

  assert.equal(summary.schemaVersion, 1);
  assert.equal(summary.issue, "EX-1"); // auto-resolved from the PR body — no --linear passed
  assert.equal(summary.repo, "example/greet");
  assert.equal(summary.prNumber, 7);
  assert.equal(summary.gateBlocked, false);
  assert.ok(summary.criteria.pass >= 1, "real execution should pass at least one criterion");
  assert.equal(summary.prCommentPosted, false); // fixtures mode never posts

  // The report referenced by the summary exists and records the crosscheck verdict.
  const report = JSON.parse(await fs.readFile(summary.reportJson, "utf8")) as RunReport;
  assert.equal(report.environment.crosscheckVerdict, "APPROVE");
});

test("e2e: vf step rejects a non-advisory --policy (phase 1 contract)", async () => {
  await assert.rejects(
    exec(
      process.execPath,
      ["--import", "tsx", "src/cli/main.ts", "step", "--pr", "x#1", "--policy", "merge_gate"],
      { cwd: repoRoot },
    ),
    (err: Error & { code?: number }) => err.code === 2,
  );
});
