/** IN-620: harness/environment error signatures — broadened for wrong-ecosystem probes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeHarnessError } from "./harnessError.js";

test("classic signatures still match", () => {
  for (const s of [
    "sh: vf: command not found",
    "sh: 1: definitely-not-a-real-binary-zzz: not found",
    "No module named pytest",
    "error: unrecognized arguments: --foo",
    "usage: pytest [options]",
  ]) {
    assert.equal(looksLikeHarnessError(s), true, s);
  }
});

test("wrong-ecosystem / missing-build signatures match (IN-620)", () => {
  for (const s of [
    "Error: Cannot find module '/repo/dist/cli/main.js'",
    "node: bad option ... ERR_MODULE_NOT_FOUND",
    "no tests ran in 0.01s",
    "ERROR: no tests collected",
    "ERROR: usage: pytest [-h]",
  ]) {
    assert.equal(looksLikeHarnessError(s), true, s);
  }
});

test("a real product failure is NOT flagged as a harness error", () => {
  assert.equal(looksLikeHarnessError("AssertionError: expected 3 but got 4"), false);
  assert.equal(looksLikeHarnessError("FAIL src/foo.test.ts > adds numbers"), false);
});
