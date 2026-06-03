/**
 * IN-553: memory reuse must match reworded-but-equivalent criteria (not just exact strings)
 * while rejecting genuinely different ones.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { MemoryStore } from "./store.js";

async function seeded(): Promise<MemoryStore> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vf-mem-"));
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
  return store;
}

test("exact criterion text reuses the stored probe (score 1, exact)", async () => {
  const store = await seeded();
  const m = await store.matchTestPointDetailed("acme/app", "`sy --version` prints `Symphony <version>` and exits 0.");
  assert.ok(m);
  assert.equal(m!.exact, true);
  assert.equal(m!.point.probe.command, "sy --version");
});

test("a reworded but equivalent criterion still reuses the probe (fuzzy)", async () => {
  const store = await seeded();
  const m = await store.matchTestPointDetailed(
    "acme/app",
    "running sy --version should print Symphony and exit with code 0",
  );
  assert.ok(m, "expected a fuzzy reuse");
  assert.equal(m!.exact, false);
  assert.ok(m!.score >= 0.6, `score ${m?.score} should clear the threshold`);
  assert.equal(m!.point.probe.command, "sy --version");
});

test("a genuinely different criterion does NOT false-match", async () => {
  const store = await seeded();
  const m = await store.matchTestPoint("acme/app", "deleting a user account removes all their billing records");
  assert.equal(m, undefined);
});

test("no memory for an unknown repo", async () => {
  const store = await seeded();
  assert.equal(await store.matchTestPoint("other/repo", "anything at all here"), undefined);
});
