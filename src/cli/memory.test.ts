/** IN-625: `vf memory` ls/show/clear over the on-disk MemoryStore. */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { MemoryStore } from "../memory/store.js";
import { memoryLs, memoryShow, memoryClear } from "./memory.js";

async function seeded(): Promise<{ store: MemoryStore; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vf-mem-cli-"));
  const store = new MemoryStore(root);
  await store.upsertTestPoint({
    repo: "acme/app",
    component: "cli",
    criterionText: "`sy --version` prints `Symphony <version>` and exits 0.",
    method: "backend",
    probe: { command: "sy --version", expectSubstring: "Symphony", fromTicket: true },
    result: "pass",
    now: "2026-06-03T00:00:00.000Z",
  });
  await store.upsertTestPoint({
    repo: "other/repo",
    component: "api",
    criterionText: "GET /health returns 200.",
    method: "integration",
    probe: { command: "curl -fsS localhost/health", fromTicket: false },
    result: "fail",
    now: "2026-06-03T00:00:00.000Z",
  });
  await store.recordFailureMode("acme/app", "missing_implementation", "cli", "2026-06-03T00:00:00.000Z");
  return { store, root };
}

test("memory ls lists repos with counts (and json)", async () => {
  const { store } = await seeded();
  const res = await memoryLs(store);
  assert.match(res.text, /acme\/app: 1 test point/);
  assert.match(res.text, /other\/repo: 1 test point/);
  const json = res.json as Array<{ repo: string; testPoints: number; failureModes: number }>;
  const acme = json.find((r) => r.repo === "acme/app")!;
  assert.equal(acme.testPoints, 1);
  assert.equal(acme.failureModes, 1);
});

test("memory ls on an empty store reports empty", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vf-mem-empty-"));
  const res = await memoryLs(new MemoryStore(root));
  assert.match(res.text, /empty/);
  assert.deepEqual(res.json, []);
});

test("memory show finds a test point by id", async () => {
  const { store } = await seeded();
  const points = await store.loadTestPoints("acme/app");
  const id = points[0]!.id;
  const res = await memoryShow(store, id);
  assert.equal(res.found, true);
  assert.match(res.text, /sy --version/);
  assert.match(res.text, /repo:\s+acme\/app/);
});

test("memory show on an unknown key is not found", async () => {
  const { store } = await seeded();
  const res = await memoryShow(store, "does-not-exist");
  assert.equal(res.found, false);
  assert.match(res.text, /no test point/);
});

test("memory clear --repo removes only that repo", async () => {
  const { store } = await seeded();
  const res = await memoryClear(store, "acme/app");
  assert.equal(res.cleared.length, 1);
  // Message reports how many test points were removed, scoped to the repo (review).
  assert.match(res.text, /cleared 1 test point\(s\) for acme\/app/);
  assert.equal((await store.loadTestPoints("acme/app")).length, 0);
  assert.equal((await store.loadTestPoints("other/repo")).length, 1, "other repo untouched");
});

test("memory clear (no repo) wipes everything", async () => {
  const { store } = await seeded();
  const res = await memoryClear(store);
  assert.ok(res.cleared.length >= 2);
  // Reports total test points across all wiped repos (review).
  assert.match(res.text, /cleared 2 test point\(s\) across 2 repo\(s\)/);
  assert.deepEqual(await store.listRepos(), []);
});

test("memory clear on an empty/absent repo reports nothing to clear", async () => {
  const { store } = await seeded();
  const res = await memoryClear(store, "nope/missing");
  assert.deepEqual(res.cleared, []);
  assert.match(res.text, /nothing stored/);
});
