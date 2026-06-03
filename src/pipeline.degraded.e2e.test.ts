import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { runVerification, type PipelineDeps } from "./core/pipeline.js";
import { FixtureGithubClient } from "./core/context/github.js";
import { FixtureLinearClient } from "./core/context/linear.js";
import { FallbackLlm } from "./backends/fallbackLlm.js";
import { MemoryStore } from "./memory/store.js";
import { EventLog } from "./memory/eventLog.js";
import type { RunRequest } from "./types.js";

// Degraded no-ticket mode (IN-570): a PR with no Linear reference anywhere — the PR's own
// description carries self-claimed acceptance criteria. Real execution still happens, but
// a positive outcome must be capped at manual_review_required (no independent source).

const repoRoot = process.cwd();
const workdir = path.join(repoRoot, "examples/example-target");

async function makeNoTicketFixture(): Promise<string> {
  const src = JSON.parse(
    await fs.readFile(path.join(repoRoot, "fixtures/example-cli/pr.json"), "utf8"),
  ) as Record<string, unknown>;
  src.body =
    "Adds a --version flag that reads the version from package.json.\n\n" +
    "## Acceptance Criteria\n\n" +
    "* `node bin/greet.mjs --version` prints `ExampleCLI <version>` (e.g. `ExampleCLI 1.2.3`) and exits 0.\n";
  src.headRef = "feat/no-ticket"; // no Linear key in the branch name either
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vf-noticket-fixture-"));
  await fs.writeFile(path.join(dir, "pr.json"), JSON.stringify(src, null, 2));
  return dir;
}

function makeDeps(fixtureDir: string, outputRoot: string): PipelineDeps {
  return {
    linear: new FixtureLinearClient(fixtureDir), // never consulted in degraded mode
    github: new FixtureGithubClient(fixtureDir),
    llm: new FallbackLlm(),
    memory: new MemoryStore(outputRoot),
    eventLog: new EventLog(outputRoot),
    clock: () => "2026-06-03T00:00:00.000Z",
  };
}

function request(outputRoot: string, allowNoTicket: boolean): RunRequest {
  return {
    linearIssue: "",
    pullRequest: "https://github.com/example/greet/pull/7",
    level: "functional",
    policy: "advisory",
    outputRoot,
    workdir,
    allowNoTicket,
  };
}

test("no ticket and no --allow-no-ticket: fails with a hint at the flag", async () => {
  const fixtureDir = await makeNoTicketFixture();
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "vf-noticket-"));
  await assert.rejects(
    runVerification(request(out, false), makeDeps(fixtureDir, out)),
    /allow-no-ticket/,
  );
});

test("degraded run: executes against the PR's own claims, capped at manual_review_required", async () => {
  const fixtureDir = await makeNoTicketFixture();
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "vf-noticket-"));
  const { report } = await runVerification(request(out, true), makeDeps(fixtureDir, out));

  // Issue context is synthesised from the PR, clearly marked.
  assert.equal(report.issue.key, "PR-7");
  assert.equal(report.issue.source, "pr-degraded");

  // Real execution still happened and the self-claimed criterion passed...
  const ac1 = report.criterionResults.find((c) => c.result === "pass");
  assert.ok(ac1, "the executable self-claimed criterion should pass via real execution");
  assert.ok(ac1!.evidence.length > 0, "pass must carry evidence");

  // ...but the verdict is capped: passing your own claims is not acceptance.
  assert.equal(report.runVerdict, "manual_review_required");
  assert.match(report.summary, /capped from accept/i);
  assert.ok(
    report.ticketQualityIssues.some((t) => t.includes("no independent acceptance source")),
    "report must carry the degraded-run stamp",
  );

  // Advisory gate stays open.
  assert.equal(report.gate?.blocked, false);
});
