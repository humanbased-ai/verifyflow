/**
 * IN-660 (journey Phase 1): the seam reports conservatively — the unavailable executor never
 * passes a criterion (every check is not-executed → blocked), and the fake driver is deterministic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FakeJourneyHarness,
  UnavailableJourneyHarness,
  toHarnessResult,
} from "./journeyHarness.js";
import { runJourneyChecks } from "./runJourneyChecks.js";
import type { CriteriaModel } from "../../types.js";

const criteria = {
  criteria: [
    { id: "AC-1", text: "user signs up then the welcome email is sent", source: "linear_explicit", method: "journey", observable: true },
    { id: "AC-2", text: "order placed then it appears in the admin dashboard", source: "linear_explicit", method: "journey", observable: true },
  ],
} as unknown as CriteriaModel;

test("UnavailableJourneyHarness never passes — not executed → blocked (exitCode null)", async () => {
  const h = new UnavailableJourneyHarness();
  assert.equal(await h.available(), false);
  const r = await h.check({ criterionId: "AC-1", criterion: "x" }, undefined);
  assert.equal(r.executed, false);
  assert.equal(r.passed, false);
  const hr = toHarnessResult(r);
  assert.equal(hr.executed, false);
  assert.equal(hr.exitCode, null, "not-executed must map to null exit (engine blocks, never pass/fail)");
});

test("FakeJourneyHarness returns deterministic outcomes with evidence", async () => {
  const h = new FakeJourneyHarness({ "AC-1": true, "AC-2": false });
  const pass = await h.check({ criterionId: "AC-1", criterion: "x" }, undefined);
  assert.equal(pass.passed, true);
  assert.equal(pass.executed, true);
  assert.ok(pass.evidence.length > 0);
  const fail = await h.check({ criterionId: "AC-2", criterion: "y" }, undefined);
  assert.equal(fail.passed, false);
  assert.equal(fail.executed, true);
});

test("runJourneyChecks maps each observable criterion to a probe-<id> result", async () => {
  const results = await runJourneyChecks(new FakeJourneyHarness({ "AC-1": true, "AC-2": false }), criteria, "http://localhost:3000");
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => r.stepId).sort(), ["probe-AC-1", "probe-AC-2"]);
  assert.equal(results.find((r) => r.stepId === "probe-AC-1")!.exitCode, 0);
  assert.equal(results.find((r) => r.stepId === "probe-AC-2")!.exitCode, 1);
});

test("runJourneyChecks with the unavailable harness blocks every criterion (none executed)", async () => {
  const results = await runJourneyChecks(new UnavailableJourneyHarness(), criteria, undefined);
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.executed === false && r.exitCode === null));
});
