/**
 * IN-559: end-to-end ui level through the real pipeline, with a fake browser driver injected.
 * Proves the orchestration (criteria → ui checks → verdict → gate) is wired, without a browser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { runVerification, type PipelineDeps } from "./pipeline.js";
import { FixtureGithubClient } from "./context/github.js";
import { FixtureLinearClient } from "./context/linear.js";
import { FallbackLlm } from "../backends/fallbackLlm.js";
import { MemoryStore } from "../memory/store.js";
import { EventLog } from "../memory/eventLog.js";
import type { UiHarness } from "../harness/ui/uiHarness.js";
import type { RunRequest } from "../types.js";

const fixtureDir = path.join(process.cwd(), "fixtures/example-cli");

function deps(outputRoot: string, uiHarness?: UiHarness): PipelineDeps {
  return {
    linear: new FixtureLinearClient(fixtureDir),
    github: new FixtureGithubClient(fixtureDir),
    llm: new FallbackLlm(),
    memory: new MemoryStore(outputRoot),
    eventLog: new EventLog(outputRoot),
    clock: () => "2026-06-03T00:00:00.000Z",
    uiHarness,
  };
}

const request = (outputRoot: string): RunRequest => ({
  linearIssue: "EX-1",
  pullRequest: "https://github.com/example/greet/pull/7",
  level: "ui",
  policy: "merge_gate",
  outputRoot,
  baseUrl: "http://localhost:3000",
});

const allPass: UiHarness = {
  name: "fake-allpass",
  available: async () => true,
  check: async (c) => ({
    criterionId: c.criterionId,
    passed: true,
    executed: true,
    detail: "ok",
    evidence: [{ type: "screenshot", path: `ui-${c.criterionId}.png` }],
  }),
};

test("ui e2e: passing browser checks → accept, with screenshot evidence per criterion", async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "vf-ui-"));
  const { report } = await runVerification(request(out), deps(out, allPass));
  assert.equal(report.runVerdict, "accept");
  assert.equal(report.gate?.blocked, false);
  const ac1 = report.criterionResults.find((c) => c.criterionId === "AC-1")!;
  assert.equal(ac1.result, "pass");
  assert.ok(ac1.evidence.some((e) => e.type === "screenshot"), "ui pass cites screenshot evidence");
});

test("ui e2e: no browser driver wired → criteria blocked, not falsely passed", async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "vf-ui-"));
  const { report } = await runVerification(request(out), deps(out)); // default UnavailableUiHarness
  assert.ok(report.criterionResults.every((c) => c.result === "blocked"));
  assert.equal(report.runVerdict, "manual_review_required");
});
