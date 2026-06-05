import type { CriteriaModel, HarnessResult } from "../../types.js";
import { type JourneyHarness, toHarnessResult } from "./journeyHarness.js";

/**
 * Run a journey harness over the observable criteria and return results the verdict engine can
 * score (one `probe-<criterionId>` HarnessResult each). When the harness is unavailable, every
 * result is "not executed" → the engine blocks those criteria rather than passing or failing them.
 */
export async function runJourneyChecks(
  harness: JourneyHarness,
  criteria: CriteriaModel,
  baseUrl: string | undefined,
): Promise<HarnessResult[]> {
  const observable = criteria.criteria.filter((c) => c.observable);
  const results: HarnessResult[] = [];
  for (const c of observable) {
    const r = await harness.check({ criterionId: c.id, criterion: c.text }, baseUrl);
    results.push(toHarnessResult(r));
  }
  return results;
}
