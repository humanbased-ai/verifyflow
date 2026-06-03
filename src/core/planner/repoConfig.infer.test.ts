import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { loadRepoConfig } from "./repoConfig.js";

async function repoWith(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vf-repo-"));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content);
  }
  return dir;
}

test("python-uv is detected from pyproject.toml + uv.lock", async () => {
  const cfg = await loadRepoConfig(await repoWith({ "pyproject.toml": "", "uv.lock": "" }));
  assert.equal(cfg.source, "inferred-python-uv");
  assert.equal(cfg.runPrefix, "uv run");
  assert.ok(!cfg.unknown);
});

test("poetry is detected from poetry.lock", async () => {
  const cfg = await loadRepoConfig(await repoWith({ "pyproject.toml": "", "poetry.lock": "" }));
  assert.equal(cfg.source, "inferred-python-poetry");
  assert.equal(cfg.runPrefix, "poetry run");
});

test("node is detected from package.json and scopes vitest to changed files", async () => {
  const cfg = await loadRepoConfig(await repoWith({ "package.json": "{}" }));
  assert.equal(cfg.source, "inferred-node");
  assert.equal(cfg.testForFiles(["src/a.test.ts"]), "npx vitest run src/a.test.ts");
});

test("go is detected from go.mod and scopes tests to changed dirs", async () => {
  const cfg = await loadRepoConfig(await repoWith({ "go.mod": "module x" }));
  assert.equal(cfg.source, "inferred-go");
  assert.equal(cfg.testForFiles(["pkg/foo/bar_test.go"]), "go test ./pkg/foo");
});

test("an unrecognized repo is reported unknown, NOT guessed as python-uv", async () => {
  const cfg = await loadRepoConfig(await repoWith({ "README.md": "# hi" }));
  assert.equal(cfg.unknown, true);
  assert.equal(cfg.source, "unknown");
  assert.notEqual(cfg.source, "inferred-python-uv");
  assert.deepEqual(cfg.setup, []);
});
