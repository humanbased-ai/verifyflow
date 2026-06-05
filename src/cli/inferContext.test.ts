import { test } from "node:test";
import assert from "node:assert/strict";
import { inferPrRef, inGitRepo } from "./inferContext.js";
import type { ExecResult } from "../util/exec.js";

// IN-678: PR/repo inference must be deterministic and offline — mock `gh`/`git`, never hit network.

const ok = (stdout: string): ExecResult => ({
  code: 0, stdout, stderr: "", durationMs: 1, executed: true, timedOut: false,
});
const fail = (code: number): ExecResult => ({
  code, stdout: "", stderr: "", durationMs: 1, executed: true, timedOut: false,
});
const missing = (): ExecResult => ({
  code: null, stdout: "", stderr: "", durationMs: 0, executed: false, timedOut: false, spawnError: "ENOENT",
});

const fakeRun =
  (result: ExecResult) =>
  async (): Promise<ExecResult> =>
    result;

test("inferPrRef: prefers the PR url from gh", async () => {
  const r = await inferPrRef({ run: fakeRun(ok(JSON.stringify({ number: 7, url: "https://github.com/o/r/pull/7" }))) });
  assert.equal(r.ref, "https://github.com/o/r/pull/7");
  assert.equal(r.reason, undefined);
});

test("inferPrRef: falls back to #number when url is absent", async () => {
  const r = await inferPrRef({ run: fakeRun(ok(JSON.stringify({ number: 42 }))) });
  assert.equal(r.ref, "#42");
});

test("inferPrRef: gh not installed → actionable reason, no ref", async () => {
  const r = await inferPrRef({ run: fakeRun(missing()) });
  assert.equal(r.ref, undefined);
  assert.match(r.reason!, /gh.*not found/i);
});

test("inferPrRef: no open PR for the branch → actionable reason", async () => {
  const r = await inferPrRef({ run: fakeRun(fail(1)) });
  assert.equal(r.ref, undefined);
  assert.match(r.reason!, /no open PR/i);
});

test("inferPrRef: unparsable gh output → reason, never throws", async () => {
  const r = await inferPrRef({ run: fakeRun(ok("not json")) });
  assert.equal(r.ref, undefined);
  assert.match(r.reason!, /could not parse/i);
});

test("inGitRepo: true only when git reports inside-work-tree", async () => {
  assert.equal(await inGitRepo({ run: fakeRun(ok("true\n")) }), true);
  assert.equal(await inGitRepo({ run: fakeRun(fail(128)) }), false);
  assert.equal(await inGitRepo({ run: fakeRun(missing()) }), false);
});
