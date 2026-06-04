import { promises as fs } from "node:fs";
import path from "node:path";
import type { CriteriaModel, EvaluationPlan, HarnessResult } from "../../types.js";
import type { LlmClient } from "../../backends/llm.js";
import { decideVerdict, type VerdictOutput } from "./engine.js";

/**
 * Persisted inputs to the verdict engine (IN-625). Written by the pipeline alongside the report so
 * `vf replay <runId>` can re-run the verdict engine deterministically against a past run's stored
 * evidence — no probe/test subprocesses, no checkout. The engine reads only these three values, so
 * capturing them is sufficient to reproduce (or re-derive, after a logic change) any verdict.
 */
export interface VerdictInputs {
  schemaVersion: 1;
  criteria: CriteriaModel;
  plan: EvaluationPlan;
  results: HarnessResult[];
}

export const VERDICT_INPUTS_FILENAME = "verdict-inputs.json";

export async function writeVerdictInputs(
  inputs: Omit<VerdictInputs, "schemaVersion">,
  runDir: string,
): Promise<string> {
  await fs.mkdir(runDir, { recursive: true });
  const p = path.join(runDir, VERDICT_INPUTS_FILENAME);
  const payload: VerdictInputs = { schemaVersion: 1, ...inputs };
  await fs.writeFile(p, JSON.stringify(payload, null, 2) + "\n");
  return p;
}

export async function readVerdictInputs(runDir: string): Promise<VerdictInputs> {
  const raw = await fs.readFile(path.join(runDir, VERDICT_INPUTS_FILENAME), "utf8");
  return JSON.parse(raw) as VerdictInputs;
}

/** Re-run the verdict engine against stored evidence. No probes are executed. */
export async function replayVerdict(inputs: VerdictInputs, llm: LlmClient): Promise<VerdictOutput> {
  return decideVerdict(inputs.criteria, inputs.plan, inputs.results, llm);
}
