/**
 * IN-559: the UI orchestration maps browser outcomes onto results the verdict engine scores,
 * and an unavailable browser driver blocks (never falsely passes).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runUiChecks } from "./runUiChecks.js";
import { FakeUiHarness, UnavailableUiHarness } from "./uiHarness.js";
import type { CriteriaModel } from "../../types.js";

const criteria: CriteriaModel = {
  ticketQualityIssues: [],
  criteria: [
    { id: "AC-1", text: "clicking Save shows a success toast", source: "linear_explicit", method: "ui", observable: true },
    { id: "AC-2", text: "the form rejects an empty email", source: "linear_explicit", method: "ui", observable: true },
    { id: "AC-3", text: "vague unobservable thing", source: "linear_explicit", method: "ui", observable: false },
  ],
};

test("fake driver: pass→exit 0 with screenshot evidence, fail→exit 1; unobservable skipped", async () => {
  const results = await runUiChecks(new FakeUiHarness({ "AC-1": true, "AC-2": false }), criteria, "http://localhost:3000");
  assert.equal(results.length, 2, "only observable criteria are checked");
  const ac1 = results.find((r) => r.stepId === "probe-AC-1")!;
  const ac2 = results.find((r) => r.stepId === "probe-AC-2")!;
  assert.equal(ac1.exitCode, 0);
  assert.ok(ac1.evidence.some((e) => e.type === "screenshot"), "a pass carries screenshot evidence");
  assert.equal(ac2.exitCode, 1);
});

test("unavailable driver: every check is not-executed (engine will block, not pass)", async () => {
  const results = await runUiChecks(new UnavailableUiHarness(), criteria, undefined);
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.executed === false));
  assert.ok(results.every((r) => r.exitCode === null));
});
