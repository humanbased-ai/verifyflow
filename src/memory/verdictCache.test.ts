/** IN-801: evidence fingerprint + verdict-cache persistence. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore, evidenceHash, type VerdictCache } from "./store.js";

const ev = (over: Partial<{ command: string; exitCode: number | null; stdout: string; stderr: string }> = {}) => ({
  command: "grep foo README.md",
  exitCode: 0,
  stdout: "foo",
  stderr: "",
  ...over,
});

test("evidenceHash is stable for identical inputs", () => {
  assert.equal(evidenceHash("crit text", ev()), evidenceHash("crit text", ev()));
});

test("evidenceHash changes when the criterion / command / exit / output changes", () => {
  const base = evidenceHash("crit text", ev());
  assert.notEqual(base, evidenceHash("OTHER crit", ev()));
  assert.notEqual(base, evidenceHash("crit text", ev({ command: "grep bar README.md" })));
  assert.notEqual(base, evidenceHash("crit text", ev({ exitCode: 1 })));
  assert.notEqual(base, evidenceHash("crit text", ev({ stdout: "different" })));
});

test("evidenceHash normalizes criterion whitespace/case (matches memory's norm)", () => {
  assert.equal(evidenceHash("The  Crit  Text", ev()), evidenceHash("the crit text", ev()));
});

test("evidenceHash returns undefined when there is no probe evidence (don't cache)", () => {
  assert.equal(evidenceHash("crit", undefined), undefined);
});

test("verdict cache persists and reloads per repo", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vf-vc-"));
  const store = new MemoryStore(root);
  assert.deepEqual(await store.loadVerdictCache("o/r"), {});
  const cache: VerdictCache = {
    abc123: { v: 1, result: "pass", reason: "ran ok", confidence: 0.92, cachedAt: "2026-06-09T00:00:00Z" },
  };
  await store.saveVerdictCache("o/r", cache);
  assert.deepEqual(await store.loadVerdictCache("o/r"), cache);
});
