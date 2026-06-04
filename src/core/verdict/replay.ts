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

/** The schema version this build knows how to replay. */
export const VERDICT_INPUTS_SCHEMA_VERSION = 1;

export async function readVerdictInputs(runDir: string): Promise<VerdictInputs> {
  const raw = await fs.readFile(path.join(runDir, VERDICT_INPUTS_FILENAME), "utf8");
  const parsed = JSON.parse(raw) as Partial<VerdictInputs>;
  // Guard against replaying evidence written by an incompatible (e.g. future) version, which
  // would otherwise feed mismatched data into the engine silently (IN-625 review).
  if (parsed.schemaVersion !== VERDICT_INPUTS_SCHEMA_VERSION) {
    throw new Error(
      `${VERDICT_INPUTS_FILENAME} schemaVersion ${String(parsed.schemaVersion)} is not supported ` +
        `by this build (expected ${VERDICT_INPUTS_SCHEMA_VERSION}) — recorded by an incompatible version.`,
    );
  }
  // Shallow shape check: a partially-written/corrupt file parses fine but would otherwise blow up
  // with a confusing TypeError deep inside decideVerdict. Fail clearly at the boundary instead.
  if (
    typeof parsed.criteria !== "object" ||
    parsed.criteria === null ||
    typeof parsed.plan !== "object" ||
    parsed.plan === null ||
    !Array.isArray(parsed.results)
  ) {
    throw new Error(`corrupt ${VERDICT_INPUTS_FILENAME}: missing criteria, plan, or results`);
  }
  return parsed as VerdictInputs;
}

/** Re-run the verdict engine against stored evidence. No probes are executed. */
export async function replayVerdict(inputs: VerdictInputs, llm: LlmClient): Promise<VerdictOutput> {
  return decideVerdict(inputs.criteria, inputs.plan, inputs.results, llm);
}
