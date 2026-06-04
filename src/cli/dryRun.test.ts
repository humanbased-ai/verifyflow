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

test("e2e: vf run --dry-run with no resolvable ticket exits 2 with a clean message (not a stack trace)", async () => {
  // Offline fixtures whose PR carries no Linear key, no --linear, no --allow-no-ticket: the issue
  // can't be resolved. cmdDryRun must surface the actionable message and exit 2 — not a fatal trace.
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "vf-dry-noticket-"));
  const fx = await fs.mkdtemp(path.join(os.tmpdir(), "vf-dry-fx-"));
  await fs.writeFile(
    path.join(fx, "pr.json"),
    JSON.stringify({
      repo: "owner/repo",
      number: 1,
      title: "no ticket here",
      body: "nothing linkable",
      url: "https://example/pr/1",
      headRef: "feature",
      headSha: "0".repeat(12),
      baseRef: "main",
      changedFiles: [],
      diff: "",
      source: "fixture",
    }),
  );
  await assert.rejects(
    exec(
      process.execPath,
      ["--import", "tsx", "src/cli/main.ts", "run", "--dry-run", "--fixtures", fx, "--pr", "owner/repo#1", "--out", out],
      { cwd: repoRoot },
    ),
    (err: Error & { code?: number; stderr?: string }) =>
      err.code === 2 &&
      /No Linear issue provided/.test(err.stderr ?? "") &&
      !/at .*\(.*:\d+:\d+\)/.test(err.stderr ?? ""),
  );
});

test("e2e: vf run --dry-run --json emits a machine-readable preview", async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "vf-dry-json-"));
  const { stdout } = await exec(
    process.execPath,
    [
      "--import", "tsx",
      "src/cli/main.ts",
      "run",
      "--dry-run",
      "--json",
      "--fixtures", "fixtures/example-cli",
      "--pr", "https://github.com/example/greet/pull/7",
      "--workdir", "examples/example-target",
      "--out", out,
    ],
    { cwd: repoRoot },
  );

  const preview = JSON.parse(stdout) as {
    issue: { key: string };
    criteria: { criteria: unknown[] };
    plan: { steps: unknown[] };
  };
  assert.equal(preview.issue.key, "EX-1");
  assert.ok(Array.isArray(preview.criteria.criteria));
  assert.ok(Array.isArray(preview.plan.steps));
});
