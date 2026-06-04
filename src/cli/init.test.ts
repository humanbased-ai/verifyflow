/** IN-611: `vf init` scaffolds a config and never clobbers an existing one. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInit, defaultConfig, CONFIG_FILENAME } from "./init.js";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "vf-init-"));
}

test("creates a valid verifyflow.config.json in a clean directory", async () => {
  const dir = await tmpDir();
  const res = await runInit(dir);
  assert.equal(res.created, true);
  assert.equal(res.path, path.join(dir, CONFIG_FILENAME));

  const written = JSON.parse(await fs.readFile(res.path, "utf8"));
  assert.deepEqual(written, defaultConfig());
  assert.ok(Array.isArray(written.setup) && typeof written.test === "string");
});

test("is idempotent: does not overwrite an existing config", async () => {
  const dir = await tmpDir();
  const target = path.join(dir, CONFIG_FILENAME);
  await fs.writeFile(target, '{"setup":["custom"],"test":"pytest"}\n');

  const res = await runInit(dir);
  assert.equal(res.created, false);
  assert.match(res.reason ?? "", /already exists/);

  const after = JSON.parse(await fs.readFile(target, "utf8"));
  assert.deepEqual(after.setup, ["custom"], "existing config is left untouched");
});
