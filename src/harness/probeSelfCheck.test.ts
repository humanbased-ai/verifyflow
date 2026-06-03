/**
 * IN-552: when a probe fails with an environment/command error (our probe is broken, not the
 * product), the harness regenerates a corrected probe and re-runs it instead of scoring blocked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { runProbeWithSelfCheck } from "../core/pipeline.js";
import { CommandRunner } from "./commandRunner.js";
import { FallbackLlm } from "../backends/fallbackLlm.js";
import type { LlmClient } from "../backends/llm.js";
import type { PlanStep } from "../types.js";
import type { RepoConfig } from "../core/planner/repoConfig.js";

const cfg: RepoConfig = { setup: [], test: "", testForFiles: () => undefined, source: "test" };
const step: PlanStep = {
  id: "probe-AC-1",
  kind: "command",
  description: "probe",
  command: "definitely-not-a-real-binary-zzz", // → "command not found", a harness error
  criterionIds: ["AC-1"],
  reusedTestPoint: false,
};

async function runner(): Promise<CommandRunner> {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "vf-selfcheck-"));
  return new CommandRunner(work, path.join(work, "artifacts"));
}

test("a broken probe is regenerated and re-run; the corrected probe's result wins", async () => {
  const llm: LlmClient = {
    name: "repair-stub",
    available: async () => true,
    complete: async () => JSON.stringify({ command: "echo ok" }),
  };
  const result = await runProbeWithSelfCheck(await runner(), step, "the thing works", cfg, llm);
  assert.equal(result.exitCode, 0, "the corrected probe (echo ok) exits 0");
  assert.match(result.stdout, /ok/);
  assert.equal(result.stepId, "probe-AC-1", "canonical id is preserved for the verdict engine");
});

test("without a real LLM, a broken probe is left as-is (no infinite loop, no invented fix)", async () => {
  const result = await runProbeWithSelfCheck(await runner(), step, "the thing works", cfg, new FallbackLlm());
  assert.notEqual(result.exitCode, 0, "unrepaired probe keeps its failing result");
});
