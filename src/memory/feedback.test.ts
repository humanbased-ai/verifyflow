/** IN-792: false-positive feedback store + pure matcher + the reusable-probe guard. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore, matchFeedbackRecords, isReusableProbeResult, type FeedbackRecord } from "./store.js";

async function tmpStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vf-fb-"));
  return { store: new MemoryStore(root), root };
}

const rec = (text: string): FeedbackRecord => ({ kind: "false_positive", criterionText: text, createdAt: "2026-06-08T00:00:00Z" });

// --- pure matcher -----------------------------------------------------------

test("matchFeedbackRecords: exact normalized-text match", () => {
  const records = [rec("The Export Button downloads a CSV")];
  assert.ok(matchFeedbackRecords(records, "the export button downloads a csv"));
});

test("matchFeedbackRecords: reworded-but-equivalent criterion fuzzy-matches", () => {
  const records = [rec("the export button downloads a CSV of the current view")];
  // Same key tokens (export, button, download, csv, view), reordered/reworded.
  assert.ok(matchFeedbackRecords(records, "downloading a CSV export of the current view from the button"));
});

test("matchFeedbackRecords: a genuinely different criterion does NOT match", () => {
  const records = [rec("the export button downloads a CSV of the current view")];
  assert.equal(matchFeedbackRecords(records, "the login page enforces password strength"), undefined);
  assert.equal(matchFeedbackRecords([], "anything"), undefined);
});

// --- reusable-probe guard ---------------------------------------------------

test("isReusableProbeResult: blocked is not cached; everything else is", () => {
  assert.equal(isReusableProbeResult("blocked"), false);
  for (const r of ["pass", "fail", "partial", "not_evaluable"] as const) {
    assert.equal(isReusableProbeResult(r), true);
  }
});

// --- disk-backed store ------------------------------------------------------

test("recordFeedback + loadFeedback roundtrip; matchFeedback reads from disk", async () => {
  const { store } = await tmpStore();
  await store.recordFeedback("o/r", rec("the export button downloads a CSV"));
  const loaded = await store.loadFeedback("o/r");
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]!.criterionText, "the export button downloads a CSV");
  assert.ok(await store.matchFeedback("o/r", "the export button downloads a csv"));
});

test("recordFeedback upserts by normalized criterion text (no duplicates)", async () => {
  const { store } = await tmpStore();
  await store.recordFeedback("o/r", { ...rec("the export button downloads a CSV"), note: "first" });
  await store.recordFeedback("o/r", { ...rec("the  Export  Button  downloads a CSV"), note: "second" });
  const loaded = await store.loadFeedback("o/r");
  assert.equal(loaded.length, 1, "same normalized text → upsert, not append");
  assert.equal(loaded[0]!.note, "second");
});

test("listFeedback reports per-repo counts; clearFeedback prunes", async () => {
  const { store } = await tmpStore();
  await store.recordFeedback("o/r", rec("alpha criterion text here"));
  await store.recordFeedback("o/r", rec("beta criterion text here"));
  let list = await store.listFeedback();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.count, 2);

  const cleared = await store.clearFeedback("o/r");
  assert.deepEqual(cleared, ["o_r"]);
  assert.deepEqual(await store.loadFeedback("o/r"), []);
  list = await store.listFeedback();
  assert.equal(list.length, 0);
});

test("clearFeedback cannot reach outside the store (traversal guard)", async () => {
  // A repo arg with separators slugs to underscores, so the resolved dir stays inside the store;
  // a sibling file outside the memory tree must survive any clearFeedback().
  const { store, root } = await tmpStore();
  const sentinel = path.join(root, "DO_NOT_DELETE");
  await fs.writeFile(sentinel, "keep me");
  await store.clearFeedback("../../DO_NOT_DELETE");
  assert.equal(await fs.readFile(sentinel, "utf8"), "keep me", "clearFeedback must not reach outside the store");
});
