/** IN-792: `vf feedback` CLI logic — resolve a criterion from a run's report.json and record it. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../memory/store.js";
import { recordFalsePositiveFromRun, setProbeFromRun, feedbackLs, feedbackClear, listRecentRuns, latestRunForPr } from "./feedback.js";

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

/** Write a run with explicit pr/finishedAt/criteria for the listing + --pr resolution tests. */
async function writeRun(
  root: string,
  runId: string,
  repo: string,
  prNumber: number,
  finishedAt: string,
  criteria: Array<{ id: string; result: string }>,
) {
  const dir = path.join(root, "runs", runId);
  await fs.mkdir(dir, { recursive: true });
  const report = {
    request: { repo, prNumber },
    issue: { key: `IN-${prNumber}` },
    finishedAt,
    criterionResults: criteria.map((c) => ({ criterionId: c.id, criterion: `text ${c.id}`, result: c.result, method: "backend", reason: "", evidence: [], confidence: 0.9 })),
  };
  await fs.writeFile(path.join(dir, "report.json"), JSON.stringify(report));
}

test("listRecentRuns: newest first, only fail/partial counted as failed", async () => {
  const root = await tmpRoot();
  await writeRun(root, "r-old", "o/r", 60, "2026-06-08T01:00:00Z", [{ id: "AC-1", result: "pass" }]);
  await writeRun(root, "r-new", "o/r", 66, "2026-06-08T03:00:00Z", [
    { id: "AC-5", result: "fail" },
    { id: "AC-6", result: "partial" },
    { id: "AC-7", result: "pass" },
  ]);
  const runs = await listRecentRuns(root);
  assert.deepEqual(runs.map((r) => r.runId), ["r-new", "r-old"], "sorted newest finishedAt first");
  assert.deepEqual(runs[0]!.failed.map((f) => f.criterionId), ["AC-5", "AC-6"], "pass excluded");
});

test("latestRunForPr: resolves the most recent run for a PR among several in flight", async () => {
  const root = await tmpRoot();
  await writeRun(root, "pr66-a", "o/r", 66, "2026-06-08T01:00:00Z", [{ id: "AC-1", result: "fail" }]);
  await writeRun(root, "pr66-b", "o/r", 66, "2026-06-08T05:00:00Z", [{ id: "AC-1", result: "fail" }]);
  await writeRun(root, "pr60-a", "o/r", 60, "2026-06-08T09:00:00Z", [{ id: "AC-1", result: "fail" }]);
  assert.equal(await latestRunForPr(root, 66), "pr66-b", "newest run for PR 66");
  assert.equal(await latestRunForPr(root, 60), "pr60-a");
  assert.equal(await latestRunForPr(root, 999), undefined, "unknown PR → undefined");
});

// --- IN-808: corrected probe → reusable test point --------------------------

test("setProbeFromRun stores a test point that matchTestPoint resolves, carrying expect flags", async () => {
  const root = await tmpRoot();
  await writeReport(root, "run1", "humanbased-ai/verifyflow"); // has AC-5
  const store = new MemoryStore(root);

  const probe = { command: 'vf demo --out /tmp/x && vf issue ls --out /tmp/x', expectSubstring: "issue", expectExitCode: 0, fromTicket: true };
  const res = await setProbeFromRun(store, root, "run1", "AC-5", probe, "2026-06-09T00:00:00Z");
  assert.equal(res.ok, true);
  assert.equal(res.repo, "humanbased-ai/verifyflow");

  // The next run's planner would resolve this via matchTestPoint on the criterion text.
  const tp = await store.matchTestPoint("humanbased-ai/verifyflow", "Setup section states that vf onboard saves the key");
  assert.ok(tp, "a test point is stored for the criterion");
  assert.equal(tp!.probe.command, probe.command);
  assert.equal(tp!.probe.expectSubstring, "issue");
  assert.equal(tp!.probe.expectExitCode, 0);
  assert.equal(tp!.probe.fromTicket, true, "stored as authoritative");
});

test("setProbeFromRun: unknown criterion / unsafe runId are clean errors", async () => {
  const root = await tmpRoot();
  await writeReport(root, "run1", "o/r");
  const store = new MemoryStore(root);
  const probe = { command: "true", fromTicket: true };
  assert.equal((await setProbeFromRun(store, root, "run1", "AC-99", probe, "t")).ok, false);
  assert.equal((await setProbeFromRun(store, root, "../escape", "AC-5", probe, "t")).ok, false);
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
