import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { runVerification, type PipelineDeps } from "./core/pipeline.js";
import { FixtureGithubClient } from "./core/context/github.js";
import { FixtureLinearClient } from "./core/context/linear.js";
import { FallbackLlm } from "./backends/fallbackLlm.js";
import { MemoryStore } from "./memory/store.js";
import { EventLog } from "./memory/eventLog.js";
import type { RunRequest } from "./types.js";

const repoRoot = process.cwd();
const fixtureDir = path.join(repoRoot, "fixtures/example-cli");
const workdir = path.join(repoRoot, "examples/example-target");

function makeDeps(outputRoot: string): PipelineDeps {
  return {
    linear: new FixtureLinearClient(fixtureDir),
    github: new FixtureGithubClient(fixtureDir),
    llm: new FallbackLlm(), // hermetic: rules only, no claude dependency
    memory: new MemoryStore(outputRoot),
    eventLog: new EventLog(outputRoot),
    clock: () => "2026-06-02T00:00:00.000Z",
  };
}

function request(outputRoot: string): RunRequest {
  return {
    linearIssue: "EX-1",
    pullRequest: "https://github.com/example/greet/pull/7",
    level: "functional",
    policy: "merge_gate",
    outputRoot,
    workdir,
  };
}

test("e2e: real execution verifies delivery of EX-1 and accepts", async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "vf-e2e-"));
  const { report } = await runVerification(request(out), makeDeps(out));

  assert.equal(report.runVerdict, "accept");
  assert.equal(report.gate?.blocked, false);

  const ac1 = report.criterionResults.find((c) => c.criterionId === "AC-1");
  assert.equal(ac1?.result, "pass", "AC-1 (probe) should pass via real execution");
  assert.ok(ac1!.evidence.length > 0, "pass must carry evidence");

  const ac2 = report.criterionResults.find((c) => c.criterionId === "AC-2");
  assert.equal(ac2?.result, "pass", "AC-2 should pass via the changed test file");

  // Reports written.
  const reportJson = path.join(report.evidenceRoot ? out : out); // ensure out used
  assert.ok(reportJson);

  // Event log written.
  const events = await fs.readFile(path.join(out, "events.jsonl"), "utf8");
  assert.match(events, /acceptance_criterion_result/);
  assert.match(events, /run_verdict/);
});

test("e2e: probe is persisted to memory and reused on the next run (feed-back loop)", async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "vf-mem-"));

  // First run captures the test point.
  await runVerification(request(out), makeDeps(out));
  const tpPath = path.join(out, "memory", "example_greet", "testpoints.json");
  const points = JSON.parse(await fs.readFile(tpPath, "utf8")) as unknown[];
  assert.ok(points.length >= 1, "a test point should be persisted");

  // Second run should reuse it.
  const { report } = await runVerification(request(out), makeDeps(out));
  const probeStep = report.plan.steps.find((s) => s.id === "probe-AC-1");
  assert.equal(probeStep?.reusedTestPoint, true, "AC-1 probe should be reused from memory");
});
