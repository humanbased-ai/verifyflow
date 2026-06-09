/** IN-801: verdict cache — same evidence → same verdict, and a cache hit skips the LLM entirely. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideVerdict, type VerdictCacheAccess } from "./engine.js";
import type { LlmClient } from "../../backends/llm.js";
import type { CriteriaModel, EvaluationPlan, Evidence, HarnessResult } from "../../types.js";

/** A passing fixture: one ticket-quoted probe, exit 0 + matching substring → rule result `pass`. */
function fixture(stdout = "ok") {
  const criteria = {
    ticketQualityIssues: [],
    criteria: [{ id: "AC-1", text: "greet prints ok", source: "linear_explicit", method: "backend", observable: true, probe: { command: "echo ok", expectSubstring: "ok", fromTicket: true } }],
  } as unknown as CriteriaModel;
  const plan = { level: "functional", notes: [], steps: [{ id: "probe-AC-1", kind: "command", description: "p", command: "echo ok", criterionIds: ["AC-1"], reusedTestPoint: false }] } as unknown as EvaluationPlan;
  const ev: Evidence[] = [{ type: "command_output", path: "probe-AC-1.log" }];
  const results: HarnessResult[] = [{ stepId: "probe-AC-1", command: "echo ok", exitCode: 0, stdout, stderr: "", durationMs: 1, executed: true, timedOut: false, evidence: ev }];
  return { criteria, plan, results };
}

/** Counting LLM: available, returns no adjustments, but records every call. */
function countingLlm() {
  const state = { calls: 0 };
  const llm: LlmClient = { name: "count", async available() { return true; }, async complete() { state.calls++; return "{}"; } };
  return { llm, state };
}

function memCache(): VerdictCacheAccess & { store: Record<string, unknown> } {
  const store: Record<string, any> = {};
  return { store, get: (h) => store[h], put: (h, v) => { store[h] = { ...v, cachedAt: "t" }; } };
}

test("IN-801: first run records a verdict into the cache", async () => {
  const { criteria, plan, results } = fixture();
  const cache = memCache();
  const { llm } = countingLlm();
  const v = await decideVerdict(criteria, plan, results, llm, { verdictCache: cache });
  assert.equal(v.criterionResults[0]!.result, "pass");
  assert.equal(Object.keys(cache.store).length, 1, "one verdict cached after first run");
});

test("IN-801: a re-run over identical evidence reuses the verdict and calls the LLM 0 times", async () => {
  const { criteria, plan, results } = fixture();
  const cache = memCache();
  await decideVerdict(criteria, plan, results, countingLlm().llm, { verdictCache: cache }); // warm

  const second = countingLlm();
  const v = await decideVerdict(criteria, plan, results, second.llm, { verdictCache: cache });
  assert.equal(second.state.calls, 0, "cache hit → no LLM call for the criterion");
  assert.equal(v.criterionResults[0]!.result, "pass");
  assert.equal(v.runVerdict, "accept");
});

test("IN-801: two runs over the same inputs produce identical criterion results", async () => {
  const f = fixture();
  const c1 = memCache();
  const r1 = await decideVerdict(f.criteria, f.plan, f.results, countingLlm().llm, { verdictCache: c1 });
  const r2 = await decideVerdict(f.criteria, f.plan, f.results, countingLlm().llm, { verdictCache: c1 });
  const strip = (rs: typeof r1.criterionResults) => rs.map((x) => ({ id: x.criterionId, result: x.result, conf: x.confidence }));
  assert.deepEqual(strip(r2.criterionResults), strip(r1.criterionResults));
});

test("IN-801: changed probe output misses the cache and adds a new entry", async () => {
  const cache = memCache();
  const a = fixture("ok");
  await decideVerdict(a.criteria, a.plan, a.results, countingLlm().llm, { verdictCache: cache });
  assert.equal(Object.keys(cache.store).length, 1);

  // Different stdout → different evidence hash → cache miss → recompute + store a 2nd entry.
  const b = fixture("totally different output");
  await decideVerdict(b.criteria, b.plan, b.results, countingLlm().llm, { verdictCache: cache });
  assert.equal(Object.keys(cache.store).length, 2, "new evidence → new cache entry, stale one kept");
});

test("IN-801: without a verdictCache, behavior is unchanged (no caching path)", async () => {
  const { criteria, plan, results } = fixture();
  const v = await decideVerdict(criteria, plan, results, countingLlm().llm);
  assert.equal(v.criterionResults[0]!.result, "pass");
});
