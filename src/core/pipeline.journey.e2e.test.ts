/**
 * IN-660 (journey Phase 1): end-to-end journey level through the real pipeline with a fake executor
 * injected. Proves the orchestration (criteria → journey checks → verdict → gate) is wired, and that
 * the default UnavailableJourneyHarness blocks (never falsely passes) until the Phase 2 executor lands.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { runVerification, planRun, type PipelineDeps } from "./pipeline.js";
import { FixtureGithubClient } from "./context/github.js";
import { FixtureLinearClient } from "./context/linear.js";
import { FallbackLlm } from "../backends/fallbackLlm.js";
import { MemoryStore } from "../memory/store.js";
import { EventLog } from "../memory/eventLog.js";
import type { JourneyHarness } from "../harness/journey/journeyHarness.js";
import type { RunRequest } from "../types.js";

const fixtureDir = path.join(process.cwd(), "fixtures/example-cli");

function deps(outputRoot: string, journeyHarness?: JourneyHarness): PipelineDeps {
  return {
    linear: new FixtureLinearClient(fixtureDir),
    github: new FixtureGithubClient(fixtureDir),
    llm: new FallbackLlm(),
    memory: new MemoryStore(outputRoot),
    eventLog: new EventLog(outputRoot),
    clock: () => "2026-06-05T00:00:00.000Z",
    journeyHarness,
  };
}

const request = (outputRoot: string): RunRequest => ({
  linearIssue: "EX-1",
  pullRequest: "https://github.com/example/greet/pull/7",
  level: "journey",
  policy: "merge_gate",
  outputRoot,
  baseUrl: "http://localhost:3000",
});

const allPass: JourneyHarness = {
  name: "fake-allpass",
  available: async () => true,
  check: async (c) => ({
    criterionId: c.criterionId,
    passed: true,
    executed: true,
    detail: "ok end to end",
    evidence: [{ type: "screenshot", path: `journey-${c.criterionId}.png` }],
  }),
};

test("journey e2e: passing end-to-end checks → accept, with evidence per criterion", async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "vf-journey-"));
  const { report } = await runVerification(request(out), deps(out, allPass));
  assert.equal(report.runVerdict, "accept");
  assert.equal(report.gate?.blocked, false);
  const ac1 = report.criterionResults.find((c) => c.criterionId === "AC-1")!;
  assert.equal(ac1.result, "pass");
  assert.ok(ac1.evidence.some((e) => e.type === "screenshot"), "journey pass cites evidence");
});

test("journey e2e: no executor wired → criteria blocked, not falsely passed", async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "vf-journey-"));
  const { report } = await runVerification(request(out), deps(out)); // default UnavailableJourneyHarness
  assert.ok(report.criterionResults.every((c) => c.result === "blocked"));
  assert.equal(report.runVerdict, "manual_review_required");
});

test("journey dry-run plans without constructing the execution harness", async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "vf-journey-dry-"));
  let factoryCalls = 0;
  const d: PipelineDeps = {
    ...deps(out),
    journeyHarnessFactory: () => {
      factoryCalls++;
      return allPass;
    },
  };
  const preview = await planRun(request(out), d);
  assert.equal(factoryCalls, 0, "dry-run must not build the journey execution harness");
  assert.equal(preview.plan.level, "journey");
  assert.ok(preview.plan.steps.length > 0, "journey plan still lists planned checks");
  assert.ok(preview.plan.notes.some((n) => /multi-step end-to-end/.test(n)), "journey plan keeps its note");
});
