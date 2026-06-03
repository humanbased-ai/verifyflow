/**
 * IN-551: an unknown repo toolchain must produce an explicit environment-blocked verdict,
 * never a guessed run nor a silent pass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlan } from "./planner.js";
import type { RepoConfig } from "./repoConfig.js";
import { decideVerdict } from "../verdict/engine.js";
import { FallbackLlm } from "../../backends/fallbackLlm.js";
import { MemoryStore } from "../../memory/store.js";
import type { CriteriaModel, PrContext } from "../../types.js";

const unknown: RepoConfig = {
  setup: [],
  test: "",
  testForFiles: () => undefined,
  source: "unknown",
  unknown: true,
};

const pr = { repo: "x/y", changedFiles: [{ path: "main.rb" }] } as unknown as PrContext;
const criteria: CriteriaModel = {
  ticketQualityIssues: [],
  criteria: [
    { id: "AC-1", text: "does the thing", source: "linear_explicit", method: "backend", observable: true },
  ],
};

test("unknown toolchain: plan emits no steps and flags environmentUnknown", async () => {
  const plan = await buildPlan("functional", criteria, pr, unknown, new MemoryStore("/tmp/vf-unused"));
  assert.equal(plan.steps.length, 0);
  assert.ok(plan.environmentUnknown, "must signal environment-unknown");
});

test("unknown toolchain: every criterion is environment-blocked, verdict needs review", async () => {
  const plan = await buildPlan("functional", criteria, pr, unknown, new MemoryStore("/tmp/vf-unused"));
  const v = await decideVerdict(criteria, plan, [], new FallbackLlm());
  const ac1 = v.criterionResults[0]!;
  assert.equal(ac1.result, "blocked");
  assert.equal(ac1.failureCategory, "environment_failure");
  assert.notEqual(ac1.result, "pass");
  assert.equal(v.runVerdict, "manual_review_required");
});
