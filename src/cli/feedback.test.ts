/** IN-792: `vf feedback` CLI logic — resolve a criterion from a run's report.json and record it. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../memory/store.js";
import { recordFalsePositiveFromRun, feedbackLs, feedbackClear } from "./feedback.js";

async function tmpRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "vf-fbcli-"));
}

/** Write a minimal report.json under <root>/runs/<runId>/ like a real run would. */
async function writeReport(root: string, runId: string, repo: string) {
  const dir = path.join(root, "runs", runId);
  await fs.mkdir(dir, { recursive: true });
  const report = {
    request: { repo },
    criterionResults: [
      { criterionId: "AC-5", criterion: "Setup section states that vf onboard saves the key to credentials.json", result: "fail", method: "backend", reason: "x", evidence: [], confidence: 0.85 },
    ],
  };
  await fs.writeFile(path.join(dir, "report.json"), JSON.stringify(report));
}

test("recordFalsePositiveFromRun resolves the criterion text + repo and stores it", async () => {
  const root = await tmpRoot();
  await writeReport(root, "IN-791_pr66_x", "humanbased-ai/verifyflow");
  const store = new MemoryStore(root);

  const res = await recordFalsePositiveFromRun(store, root, "IN-791_pr66_x", "AC-5", "2026-06-08T00:00:00Z", "docs AC");
  assert.equal(res.ok, true);
  assert.equal(res.repo, "humanbased-ai/verifyflow");

  const stored = await store.loadFeedback("humanbased-ai/verifyflow");
  assert.equal(stored.length, 1);
  assert.match(stored[0]!.criterionText, /vf onboard saves the key/);
  assert.equal(stored[0]!.note, "docs AC");
  assert.equal(stored[0]!.runId, "IN-791_pr66_x", "record is auditable: carries the source runId");
});

test("recordFalsePositiveFromRun: unknown run id is rejected, nothing stored", async () => {
  const root = await tmpRoot();
  const store = new MemoryStore(root);
  const res = await recordFalsePositiveFromRun(store, root, "nope", "AC-1", "2026-06-08T00:00:00Z");
  assert.equal(res.ok, false);
  assert.match(res.text, /no report\.json/);
});

test("recordFalsePositiveFromRun: unsafe run id is rejected before touching disk", async () => {
  const root = await tmpRoot();
  const store = new MemoryStore(root);
  const res = await recordFalsePositiveFromRun(store, root, "../escape", "AC-1", "2026-06-08T00:00:00Z");
  assert.equal(res.ok, false);
  assert.match(res.text, /not a valid run id/);
});

test("recordFalsePositiveFromRun: unknown criterion id lists the available ids", async () => {
  const root = await tmpRoot();
  await writeReport(root, "run1", "o/r");
  const store = new MemoryStore(root);
  const res = await recordFalsePositiveFromRun(store, root, "run1", "AC-99", "2026-06-08T00:00:00Z");
  assert.equal(res.ok, false);
  assert.match(res.text, /no criterion "AC-99"/);
  assert.match(res.text, /AC-5/, "lists the ids that do exist");
});

test("feedbackLs and feedbackClear round-trip via the CLI helpers", async () => {
  const root = await tmpRoot();
  await writeReport(root, "run1", "o/r");
  const store = new MemoryStore(root);
  await recordFalsePositiveFromRun(store, root, "run1", "AC-5", "2026-06-08T00:00:00Z");

  const ls = await feedbackLs(store);
  assert.match(ls.text, /o\/r: 1 record/);
  assert.deepEqual(ls.json, [{ repo: "o/r", feedback: 1 }]);

  const cleared = await feedbackClear(store, "o/r");
  assert.match(cleared.text, /cleared for o\/r/);
  assert.equal((await store.listFeedback()).length, 0, "nothing left after clear");
});
