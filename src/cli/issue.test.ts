/** IN-807: `vf issue` — analyze (stub LLM + fallback), persist to memory, --from-run extraction. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../memory/store.js";
import { analyzeIssue, captureIssue, issueContextFromRun, issueLs } from "./issue.js";
import type { LlmClient } from "../backends/llm.js";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "vf-issue-"));

const analyzingLlm: LlmClient = {
  name: "stub",
  async available() { return true; },
  async complete() {
    return JSON.stringify({ title: "vf onboard exits 1 in sandbox", category: "environment", rootCause: "secret stripped", impact: "false fail", reproduction: "run in sandbox", suggestedFix: "treat as env failure" });
  },
};
const noLlm: LlmClient = { name: "none", async available() { return false; }, async complete() { return ""; } };

test("analyzeIssue: parses the LLM's structured JSON", async () => {
  const a = await analyzeIssue(analyzingLlm, "vf onboard fails");
  assert.equal(a.title, "vf onboard exits 1 in sandbox");
  assert.equal(a.category, "environment");
  assert.equal(a.suggestedFix, "treat as env failure");
});

test("analyzeIssue: falls back to a minimal record when no LLM is available", async () => {
  const a = await analyzeIssue(noLlm, "first line of the bug\nmore detail");
  assert.equal(a.title, "first line of the bug");
  assert.equal(a.category, "unknown");
  assert.equal(a.rootCause, "");
});

test("captureIssue: stores an analyzed record under the repo", async () => {
  const root = await tmp();
  const store = new MemoryStore(root);
  const res = await captureIssue(store, analyzingLlm, { repo: "o/r", input: "vf onboard fails", source: "manual", now: "2026-06-09T00:00:00Z" });
  assert.equal(res.ok, true);
  assert.match(res.record!.id, /^iss_/);
  const stored = await store.loadIssues("o/r");
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.title, "vf onboard exits 1 in sandbox");
  assert.equal(stored[0]!.source, "manual");
});

test("captureIssue still works with no LLM (deterministic fallback record)", async () => {
  const root = await tmp();
  const store = new MemoryStore(root);
  await captureIssue(store, noLlm, { repo: "o/r", input: "watch crashed on TLS timeout", source: "manual", now: "2026-06-09T00:00:00Z" });
  const stored = await store.loadIssues("o/r");
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.title, "watch crashed on TLS timeout");
});

test("issueContextFromRun: builds error context from a run's non-pass criteria", async () => {
  const root = await tmp();
  const dir = path.join(root, "runs", "run1");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "report.json"), JSON.stringify({
    request: { repo: "humanbased-ai/app", prNumber: 70 },
    issue: { key: "IN-900" },
    runVerdict: "needs_fix",
    criterionResults: [
      { criterionId: "AC-1", criterion: "exports CSV", result: "pass", method: "ui", reason: "ok", evidence: [], confidence: 0.9 },
      { criterionId: "AC-2", criterion: "CSV has a date column", result: "fail", method: "ui", reason: "no date column found", evidence: [], confidence: 0.85 },
    ],
  }));
  const res = await issueContextFromRun(root, "run1");
  assert.equal(res.ok, true);
  assert.equal(res.repo, "humanbased-ai/app");
  assert.match(res.input!, /Run verdict: needs_fix/);
  assert.match(res.input!, /AC-2 \[fail\] CSV has a date column — no date column found/);
  assert.doesNotMatch(res.input!, /AC-1/, "passing criteria are not part of the error context");
});

test("issueContextFromRun: unsafe / unknown run id is rejected cleanly", async () => {
  const root = await tmp();
  assert.equal((await issueContextFromRun(root, "../escape")).ok, false);
  assert.equal((await issueContextFromRun(root, "nope")).ok, false);
});

test("issueContextFromRun: a malformed report.json is a clean error, not a crash (review fix)", async () => {
  const root = await tmp();
  const dir = path.join(root, "runs", "bad");
  await fs.mkdir(dir, { recursive: true });
  // Parses fine but missing criterionResults / request — must not throw.
  await fs.writeFile(path.join(dir, "report.json"), JSON.stringify({ schemaVersion: 1 }));
  const res = await issueContextFromRun(root, "bad");
  assert.equal(res.ok, false);
  assert.match(res.text!, /missing expected fields/);
});

test("recordIssue de-duplicates by content (re-capturing the same bug is idempotent, review fix)", async () => {
  const root = await tmp();
  const store = new MemoryStore(root);
  const a = await captureIssue(store, noLlm, { repo: "o/r", input: "the same bug", source: "manual", now: "2026-06-09T00:00:00Z" });
  const b = await captureIssue(store, noLlm, { repo: "o/r", input: "the same bug", source: "manual", now: "2026-06-09T09:00:00Z" });
  assert.equal(a.record!.id, b.record!.id, "same content → same id");
  assert.equal((await store.loadIssues("o/r")).length, 1, "no duplicate appended");
});

test("issueLs lists captured issues per repo; findIssue resolves by id", async () => {
  const root = await tmp();
  const store = new MemoryStore(root);
  const { record } = await captureIssue(store, analyzingLlm, { repo: "o/r", input: "bug A", source: "manual", now: "2026-06-09T00:00:00Z" });
  const ls = await issueLs(store);
  assert.match(ls.text, /o\/r: 1 issue/);
  assert.deepEqual(ls.json, [{ repo: "o/r", issues: 1 }]);
  const found = await store.findIssue(record!.id);
  assert.equal(found?.id, record!.id);
});
