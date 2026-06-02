import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

test("greet --version prints ExampleCLI <version> and exits 0", () => {
  const out = execFileSync("node", ["bin/greet.mjs", "--version"], { encoding: "utf8" });
  assert.match(out, /^ExampleCLI \d+\.\d+\.\d+/);
});
