/**
 * A live functional `vf run` with no --workdir/--checkout (and outside a repo checkout, so context
 * inference can't default workdir to ".") must fail fast with a usage error — not silently emit an
 * all-blocked report with exit 0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repoRoot = process.cwd();
const mainTs = path.join(repoRoot, "src", "cli", "main.ts");

test("e2e: live functional run without --workdir/--checkout outside a repo exits 2 with guidance", async () => {
  // cwd is a non-git temp dir so applyContextInference cannot default workdir to ".".
  // Symlink node_modules so `--import tsx` still resolves from there.
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "vf-noexec-"));
  await fs.symlink(path.join(repoRoot, "node_modules"), path.join(cwd, "node_modules"), "dir");
  await assert.rejects(
    exec(
      process.execPath,
      ["--import", "tsx", mainTs, "run", "--pr", "https://github.com/example/greet/pull/7", "--level", "functional"],
      { cwd },
    ),
    (err: Error & { code?: number; stderr?: string }) => {
      assert.equal(err.code, 2);
      assert.match(err.stderr ?? "", /nothing to execute without a checkout/);
      assert.match(err.stderr ?? "", /--checkout/);
      assert.match(err.stderr ?? "", /--dry-run/);
      return true;
    },
  );
});

test("e2e: feedback with no run for the PR hints at --out", async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "vf-fbhint-"));
  await assert.rejects(
    exec(
      process.execPath,
      ["--import", "tsx", mainTs, "feedback", "--pr", "99", "--criterion", "AC-1", "--out", out],
      { cwd: repoRoot },
    ),
    (err: Error & { code?: number; stderr?: string }) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr ?? "", /no run found for PR #99/);
      assert.match(err.stderr ?? "", /--out <dir>/);
      return true;
    },
  );
});
