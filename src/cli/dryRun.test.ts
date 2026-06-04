/** IN-625: `vf run --dry-run` prints resolved criteria + planned steps and runs nothing. */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repoRoot = process.cwd();

test("e2e: vf run --dry-run prints criteria + plan, exits 0, executes nothing", async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "vf-dry-"));
  const { stdout } = await exec(
    process.execPath,
    [
      "--import", "tsx",
      "src/cli/main.ts",
      "run",
      "--dry-run",
      "--fixtures", "fixtures/example-cli",
      "--pr", "https://github.com/example/greet/pull/7",
      "--workdir", "examples/example-target",
      "--out", out,
    ],
    { cwd: repoRoot },
  );

  // Resolved criteria + planned steps are printed.
  assert.match(stdout, /Dry run — EX-1/);
  assert.match(stdout, /Resolved acceptance criteria/);
  assert.match(stdout, /Planned steps/);
  assert.match(stdout, /AC-1/);
  assert.match(stdout, /dry run — no probes or tests were executed/);

  // No run directory / artifacts were written (planning has no execution side effects).
  const runsExists = await fs
    .stat(path.join(out, "runs"))
    .then(() => true)
    .catch(() => false);
  assert.equal(runsExists, false, "dry-run must not create a runs/ directory");
});

test("e2e: vf run --dry-run requires --pr", async () => {
  await assert.rejects(
    exec(process.execPath, ["--import", "tsx", "src/cli/main.ts", "run", "--dry-run"], { cwd: repoRoot }),
    (err: Error & { code?: number }) => err.code === 2,
  );
});
