import { test } from "node:test";
import assert from "node:assert/strict";
import { adaptCommand, type RepoConfig } from "./repoConfig.js";

const uv: RepoConfig = {
  setup: [],
  test: "pytest -q",
  testForFiles: () => undefined,
  runPrefix: "uv run",
  source: "test",
};

test("simple project entrypoint gets the run prefix", () => {
  assert.equal(adaptCommand("symphony info", uv), "uv run symphony info");
});

test("a compound command is wrapped whole, so every sub-command runs in the project env", () => {
  // The IN-545 bug: this used to become `uv run d=$(mktemp -d); symphony …`, gluing the prefix
  // onto the assignment and leaving `symphony` to hit the system binary.
  const cmd = 'd=$(mktemp -d); symphony info "$d/WORKFLOW.md"';
  const out = adaptCommand(cmd, uv);
  assert.match(out, /^uv run sh -c '/, "must wrap the whole command in `uv run sh -c`");
  assert.ok(!/uv run d=/.test(out), "must not prefix the shell assignment");
  assert.ok(out.includes("symphony info"), "the real command is preserved inside the wrapper");
});

test("python interpreter is prefixed so it uses the project env (not system python)", () => {
  // The IN-545 bug: `python3 -m pytest` was left unprefixed → "No module named pytest".
  assert.equal(adaptCommand("python3 -m pytest tests -k info", uv), "uv run python3 -m pytest tests -k info");
});

test("already-prefixed and system binaries are left alone", () => {
  assert.equal(adaptCommand("uv run pytest -q", uv), "uv run pytest -q");
  assert.equal(adaptCommand("git status", uv), "git status");
});

test("no runPrefix (e.g. node project) is a passthrough", () => {
  const node: RepoConfig = { setup: [], test: "npm test", testForFiles: () => undefined, source: "test" };
  assert.equal(adaptCommand('d=$(mktemp -d); node x.js', node), 'd=$(mktemp -d); node x.js');
});
