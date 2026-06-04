/** IN-625: `vf show` / `vf signal` render a past run's stored report / improvement signal. */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { showRun, showSignal, renderSignal, runDirFor, isUnsafeRunId } from "./inspect.js";
import type { ImprovementSignal } from "../types.js";

async function makeRun(): Promise<{ outputRoot: string; runId: string }> {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vf-show-"));
  const runId = "EX-1_pr7_20260603000000";
  const dir = runDirFor(outputRoot, runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "report.md"), "# VerifyFlow delivery report — EX-1\n\n> ok\n");
  await fs.writeFile(path.join(dir, "report.json"), JSON.stringify({ runVerdict: "accept" }, null, 2) + "\n");
  const signal: ImprovementSignal = {
    schemaVersion: 1,
    repo: "example/greet",
    prNumber: 7,
    commitSha: "deadbeef",
    linearIssue: "EX-1",
    verdict: "needs_fix",
    items: [
      {
        criterionId: "AC-1",
        criterion: "`greet --version` prints the version",
        result: "fail",
        severity: "must_fix",
        failureCategory: "missing_implementation",
        expected: "`greet --version` → exit 0",
        observed: "exit 1; unknown flag",
        probeCommand: "greet --version",
        evidence: ["artifacts/probe-AC-1.log"],
      },
    ],
  };
  await fs.writeFile(path.join(dir, "improvement-signal.json"), JSON.stringify(signal, null, 2) + "\n");
  return { outputRoot, runId };
}

test("show renders report.md", async () => {
  const { outputRoot, runId } = await makeRun();
  const res = await showRun(outputRoot, runId, false);
  assert.equal(res.found, true);
  assert.match(res.text, /VerifyFlow delivery report — EX-1/);
});

test("show --json renders report.json", async () => {
  const { outputRoot, runId } = await makeRun();
  const res = await showRun(outputRoot, runId, true);
  assert.equal(res.found, true);
  assert.match(res.text, /"runVerdict": "accept"/);
});

test("show on a missing run is not found", async () => {
  const { outputRoot } = await makeRun();
  const res = await showRun(outputRoot, "no-such-run", false);
  assert.equal(res.found, false);
  assert.match(res.text, /no report\.md/);
});

test("signal pretty-prints the improvement signal", async () => {
  const { outputRoot, runId } = await makeRun();
  const res = await showSignal(outputRoot, runId, false);
  assert.equal(res.found, true);
  assert.match(res.text, /AC-1 \[must_fix\]/);
  assert.match(res.text, /expected: `greet --version` → exit 0/);
  assert.match(res.text, /observed: exit 1; unknown flag/);
  assert.match(res.text, /probe:\s+greet --version/);
});

test("signal --json returns the raw json", async () => {
  const { outputRoot, runId } = await makeRun();
  const res = await showSignal(outputRoot, runId, true);
  assert.equal(res.found, true);
  assert.match(res.text, /"schemaVersion": 1/);
});

test("signal on a clean run (no signal file) is not found with a clear message", async () => {
  const { outputRoot } = await makeRun();
  const res = await showSignal(outputRoot, "clean-run", false);
  assert.equal(res.found, false);
  assert.match(res.text, /every criterion passed|does not exist/);
});

test("IN-625 review: isUnsafeRunId rejects path-traversal run ids", () => {
  // Legitimate run ids pass.
  assert.equal(isUnsafeRunId("EX-1_pr7_20260603000000"), false);
  // Anything that isn't a bare directory name is rejected.
  for (const bad of ["../../etc/passwd", "..", "a/b", "/abs/path", "x\0y", "sub/run"]) {
    assert.equal(isUnsafeRunId(bad), true, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test("renderSignal includes all items", () => {
  const text = renderSignal({
    schemaVersion: 1,
    repo: "r/p",
    prNumber: 1,
    commitSha: "abc",
    linearIssue: "K-1",
    verdict: "needs_fix",
    items: [
      { criterionId: "AC-1", criterion: "a", result: "fail", severity: "must_fix", expected: "x", observed: "y", evidence: [] },
      { criterionId: "AC-2", criterion: "b", result: "not_evaluable", severity: "needs_clarification", expected: "x", observed: "y", evidence: [] },
    ],
  });
  assert.match(text, /AC-1/);
  assert.match(text, /AC-2/);
  assert.match(text, /2 actionable item/);
});
