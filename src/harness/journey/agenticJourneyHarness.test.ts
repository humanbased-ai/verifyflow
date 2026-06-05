/**
 * IN-661 (journey Phase 2): the agentic executor composes backend + browser steps and keeps the
 * conservative verdict guardrails — only a confident, executed fail is a fail; everything else blocks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgenticJourneyHarness, type CommandOutcome } from "./agenticJourneyHarness.js";
import { FakeBrowserDriver, type BrowserDriver } from "../ui/browserDriver.js";
import type { LlmClient } from "../../backends/llm.js";

/** A fake LLM that replays a queued list of raw JSON replies, one per turn. */
function scriptedLlm(replies: string[]): LlmClient {
  let i = 0;
  return {
    name: "scripted",
    available: async () => true,
    complete: async () => replies[i++] ?? '{"conclusion":"cannot_verify","observation":"script exhausted"}',
  };
}

const check = { criterionId: "AC-1", criterion: "after creating an item via the CLI, it is listed by the list command" };

function fakeRun(outcomes: CommandOutcome[]): { run: (c: string, l: string) => Promise<CommandOutcome>; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    run: async (command: string) => {
      calls.push(command);
      return outcomes[i++] ?? { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

test("backend-only journey: run a command, observe output, conclude pass", async () => {
  const llm = scriptedLlm([
    JSON.stringify({ thought: "create then list", action: { kind: "run", command: "cli add x && cli list" } }),
    JSON.stringify({ conclusion: "pass", observation: "list output contained x" }),
  ]);
  const { run, calls } = fakeRun([{ exitCode: 0, stdout: "items: x", stderr: "" }]);
  const h = new AgenticJourneyHarness({ llm, artifactsDir: "/tmp", runCommand: run });
  const r = await h.check(check, undefined);
  assert.equal(r.executed, true);
  assert.equal(r.passed, true);
  assert.deepEqual(calls, ["cli add x && cli list"]);
});

test("a run with a non-zero exit is a finding, not a harness error — agent may still conclude fail", async () => {
  const llm = scriptedLlm([
    JSON.stringify({ action: { kind: "run", command: "cli list" } }),
    JSON.stringify({ conclusion: "fail", observation: "the created item was absent from the list" }),
  ]);
  const { run } = fakeRun([{ exitCode: 0, stdout: "items: (none)", stderr: "" }]);
  // failConfirmations 1 → no anti-flake re-run needed for this assertion.
  const h = new AgenticJourneyHarness({ llm, artifactsDir: "/tmp", runCommand: run, failConfirmations: 1 });
  const r = await h.check(check, undefined);
  assert.equal(r.executed, true);
  assert.equal(r.passed, false);
});

test("anti-flake: a fail not reproduced on re-run is downgraded to blocked (executed:false)", async () => {
  // Two independent runs: first concludes fail, second concludes pass → must NOT be a fail.
  const llm = scriptedLlm([
    JSON.stringify({ conclusion: "fail", observation: "missing" }),
    JSON.stringify({ conclusion: "pass", observation: "present after all" }),
  ]);
  const h = new AgenticJourneyHarness({ llm, artifactsDir: "/tmp", runCommand: fakeRun([]).run, failConfirmations: 2 });
  const r = await h.check(check, undefined);
  assert.equal(r.executed, false, "unreproduced fail must block, never fail");
  assert.equal(r.passed, false);
});

test("no capability wired (no runCommand, no driver) → available() false and runs block", async () => {
  const llm = scriptedLlm([JSON.stringify({ action: { kind: "run", command: "x" } })]);
  const h = new AgenticJourneyHarness({ llm, artifactsDir: "/tmp", maxConsecutiveActionErrors: 1 });
  assert.equal(await h.available(), false);
  const r = await h.check(check, undefined);
  assert.equal(r.executed, false); // blocked, never falsely passed/failed
});

test("poll: re-runs until the downstream signal appears, then concludes pass (IN-662)", async () => {
  const llm = scriptedLlm([
    JSON.stringify({ action: { kind: "poll", poll: { command: "check-webhook", expectSubstring: "delivered", timeoutMs: 10000, intervalMs: 1 } } }),
    JSON.stringify({ conclusion: "pass", observation: "webhook was delivered downstream" }),
  ]);
  let n = 0;
  const run = async (): Promise<CommandOutcome> => {
    n++;
    return { exitCode: 0, stdout: n >= 3 ? "status: delivered" : "status: pending", stderr: "" };
  };
  const h = new AgenticJourneyHarness({ llm, artifactsDir: "/tmp", runCommand: run, sleep: async () => {} });
  const r = await h.check(check, undefined);
  assert.equal(r.executed, true);
  assert.equal(r.passed, true);
  assert.ok(n >= 3, "polled until the signal appeared");
});

test("poll timeout → downstream signal absent → blocked, never fail (IN-662)", async () => {
  const llm = scriptedLlm([
    JSON.stringify({ action: { kind: "poll", poll: { command: "check-row", expectSubstring: "ok", timeoutMs: 5, intervalMs: 1 } } }),
    JSON.stringify({ conclusion: "cannot_verify", observation: "row not persisted within timeout" }),
  ]);
  let now = 0;
  const h = new AgenticJourneyHarness({
    llm,
    artifactsDir: "/tmp",
    runCommand: async () => ({ exitCode: 0, stdout: "status: pending", stderr: "" }),
    sleep: async () => {},
    now: () => (now += 3), // advance past the 5ms budget after ~2 attempts
  });
  const r = await h.check(check, undefined);
  assert.equal(r.executed, false, "a downstream signal absent within the timeout must block, never fail");
});

test("IN-663: a browser session trace is collected as browser_trace evidence via finalize()", async () => {
  const llm = scriptedLlm([
    JSON.stringify({ action: { kind: "browser", browser: { kind: "navigate", value: "/" } } }),
    JSON.stringify({ conclusion: "pass", observation: "saw it" }),
  ]);
  const tracingDriver: BrowserDriver = {
    name: "fake-trace",
    available: async () => true,
    open: async () => ({
      observe: async () => ({ url: "u", title: "t", domSummary: "", consoleErrors: [] }),
      perform: async () => ({ ok: true }),
      finalize: async () => [{ type: "browser_trace", path: "ui/trace-1.zip", summary: "trace" }],
      close: async () => {},
    }),
  };
  const h = new AgenticJourneyHarness({ llm, artifactsDir: "/tmp", driver: tracingDriver });
  const r = await h.check(check, "http://localhost:3000");
  assert.equal(r.passed, true);
  assert.ok(r.evidence.some((e) => e.type === "browser_trace"), "session trace is attached as evidence");
});

test("browser step uses the driver; missing base URL blocks the browser action", async () => {
  const llm = scriptedLlm([
    JSON.stringify({ action: { kind: "browser", browser: { kind: "navigate", value: "/" } } }),
  ]);
  // driver present but no baseUrl → browser unavailable → with maxConsecutiveActionErrors 1, blocks.
  const h = new AgenticJourneyHarness({
    llm,
    artifactsDir: "/tmp",
    driver: new FakeBrowserDriver({ observations: [] }),
    maxConsecutiveActionErrors: 1,
  });
  const r = await h.check(check, undefined);
  assert.equal(r.executed, false);
});
