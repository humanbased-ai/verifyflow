/** IN-625: `vf replay` re-derives a verdict from stored evidence with no probe execution. */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { writeVerdictInputs, readVerdictInputs, replayVerdict, VERDICT_INPUTS_FILENAME } from "./replay.js";
import { FallbackLlm } from "../../backends/fallbackLlm.js";
import type { CriteriaModel, EvaluationPlan, HarnessResult } from "../../types.js";

function inputsFor(exitCode: number): { criteria: CriteriaModel; plan: EvaluationPlan; results: HarnessResult[] } {
  const criteria: CriteriaModel = {
    criteria: [
      {
        id: "AC-1",
        text: "`greet --version` prints ExampleCLI <version> and exits 0",
        source: "linear_explicit",
        method: "backend",
        observable: true,
        probe: { command: "node bin/greet.mjs --version", expectSubstring: "ExampleCLI", fromTicket: true },
      },
    ],
    ticketQualityIssues: [],
  };
  const plan: EvaluationPlan = {
    level: "functional",
    steps: [
      {
        id: "probe-AC-1",
        kind: "command",
        description: "probe for AC-1",
        command: "node bin/greet.mjs --version",
        criterionIds: ["AC-1"],
        expectSubstring: "ExampleCLI",
        expectExitCode: 0,
        reusedTestPoint: false,
      },
    ],
    notes: [],
  };
  const results: HarnessResult[] = [
    {
      stepId: "probe-AC-1",
      command: "node bin/greet.mjs --version",
      exitCode,
      stdout: exitCode === 0 ? "ExampleCLI 1.2.3\n" : "error: unknown flag\n",
      stderr: "",
      durationMs: 12,
      executed: true,
      timedOut: false,
      evidence: [{ type: "command_output", path: "probe-AC-1.log" }],
    },
  ];
  return { criteria, plan, results };
}

test("replay reproduces a pass verdict from stored passing evidence", async () => {
  const verdict = await replayVerdict({ schemaVersion: 1, ...inputsFor(0) }, new FallbackLlm());
  assert.equal(verdict.runVerdict, "accept");
  assert.equal(verdict.criterionResults[0]!.result, "pass");
});

test("replay reproduces a needs_fix verdict from stored failing evidence", async () => {
  const verdict = await replayVerdict({ schemaVersion: 1, ...inputsFor(1) }, new FallbackLlm());
  assert.equal(verdict.runVerdict, "needs_fix");
  assert.equal(verdict.criterionResults[0]!.result, "fail");
});

test("write/read verdict inputs round-trips through disk and replays identically", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "vf-replay-"));
  const inputs = inputsFor(0);
  const p = await writeVerdictInputs(inputs, runDir);
  assert.equal(path.basename(p), VERDICT_INPUTS_FILENAME);

  const loaded = await readVerdictInputs(runDir);
  assert.equal(loaded.schemaVersion, 1);
  const verdict = await replayVerdict(loaded, new FallbackLlm());
  assert.equal(verdict.runVerdict, "accept");
});

test("readVerdictInputs rejects an unsupported schemaVersion (review)", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "vf-replay-ver-"));
  // Simulate evidence written by a future, incompatible version.
  const payload = { schemaVersion: 2, ...inputsFor(0) };
  await fs.writeFile(path.join(runDir, VERDICT_INPUTS_FILENAME), JSON.stringify(payload, null, 2));
  await assert.rejects(readVerdictInputs(runDir), /schemaVersion 2 is not supported/);
});

test("readVerdictInputs rejects a corrupt/partial file (missing criteria/plan/results)", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "vf-replay-corrupt-"));
  // Valid version, but truncated before the payload was written.
  await fs.writeFile(path.join(runDir, VERDICT_INPUTS_FILENAME), JSON.stringify({ schemaVersion: 1 }));
  await assert.rejects(readVerdictInputs(runDir), /corrupt verdict-inputs\.json/);
});

// AC-5: `vf replay` must derive the verdict from *stored* evidence without re-executing any
// probe/test subprocess. That negative guarantee can't be read off CLI output (PR #28 review), so
// we assert it behaviorally: the stored evidence is a PASS whose probe command points at a binary
// that does not exist. If replay re-ran the probe the process would fail to spawn (executed:false)
// and the deterministic engine could not produce a confident pass — so a reproduced pass is only
// possible by trusting the stored output, i.e. by spawning nothing.
test("replay re-executes no probe/test — reproduces a pass even when the command is unrunnable", async () => {
  const inputs = inputsFor(0); // stored evidence: a clean pass captured on the original run...
  // ...but rewrite every command reference to a binary that cannot exist on any PATH.
  const unrunnable = "/nonexistent/vf-replay-must-not-run --version";
  inputs.criteria.criteria[0]!.probe!.command = unrunnable;
  inputs.plan.steps[0]!.command = unrunnable;
  inputs.results[0]!.command = unrunnable;

  const verdict = await replayVerdict({ schemaVersion: 1, ...inputs }, new FallbackLlm());
  // A confident pass is unreachable if the command had been re-run, proving stored evidence is reused.
  assert.equal(verdict.runVerdict, "accept");
  assert.equal(verdict.criterionResults[0]!.result, "pass");
});
