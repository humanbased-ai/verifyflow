/**
 * IN-606 PR-2: AI-driven UI harness verdict guardrails.
 * The agent decides; VerifyFlow judges conservatively. The contract under test: only a
 * confident, re-confirmed `fail` becomes executed:false→pass/fail; everything uncertain becomes
 * executed:false so the verdict engine blocks (never a false fail).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgenticUiHarness } from "./agenticUiHarness.js";
import { FakeBrowserDriver, type PageObservation } from "./browserDriver.js";
import type { LlmClient, LlmRequest } from "../../backends/llm.js";

/** LLM stub: returns scripted replies in order, repeating the last (so loops terminate). */
class QueueLlm implements LlmClient {
  readonly name = "queue-llm";
  readonly prompts: string[] = [];
  private i = 0;
  constructor(private readonly replies: string[]) {}
  async available() {
    return true;
  }
  async complete(req: LlmRequest): Promise<string> {
    this.prompts.push(req.prompt);
    const r = this.replies[Math.min(this.i, this.replies.length - 1)];
    this.i++;
    return r ?? "{}";
  }
}

const obs = (over: Partial<PageObservation> = {}): PageObservation => ({
  url: "http://localhost:3000",
  title: "App",
  domSummary: "<button>Save",
  screenshotPath: "ui/step-1.png",
  consoleErrors: [],
  ...over,
});

const check = { criterionId: "AC-1", criterion: "clicking Save shows a success toast" };
const harnessWith = (driver: FakeBrowserDriver, llm: LlmClient, extra = {}) =>
  new AgenticUiHarness({ driver, llm, artifactsDir: "/tmp/vf", failConfirmations: 2, ...extra });

test("pass: agent concludes pass → executed, passed, screenshot evidence", async () => {
  const driver = new FakeBrowserDriver({ observations: [obs()] });
  const llm = new QueueLlm([`{"conclusion":"pass","observation":"saw the success toast"}`]);
  const r = await harnessWith(driver, llm).check(check, "http://localhost:3000");
  assert.equal(r.executed, true);
  assert.equal(r.passed, true);
  assert.ok(r.evidence.some((e) => e.type === "screenshot"));
});

test("confirmed fail: every run agrees → executed, not passed", async () => {
  const driver = new FakeBrowserDriver({ observations: [obs()] });
  const llm = new QueueLlm([`{"conclusion":"fail","observation":"no toast appeared"}`]); // repeats → both runs fail
  const r = await harnessWith(driver, llm).check(check, "http://localhost:3000");
  assert.equal(r.executed, true);
  assert.equal(r.passed, false);
});

test("flaky fail is downgraded: run1 fail, run2 not-fail → blocked (executed:false)", async () => {
  const driver = new FakeBrowserDriver({ observations: [obs()] });
  const llm = new QueueLlm([
    `{"conclusion":"fail","observation":"no toast"}`,
    `{"conclusion":"pass","observation":"toast was there after all"}`,
  ]);
  const r = await harnessWith(driver, llm).check(check, "http://localhost:3000");
  assert.equal(r.executed, false, "a non-reproduced fail must not fail the criterion");
  assert.match(r.detail, /downgraded to cannot_verify/);
});

test("cannot_verify (login wall / element missing) → blocked, never fail", async () => {
  const driver = new FakeBrowserDriver({ observations: [obs()] });
  const llm = new QueueLlm([`{"conclusion":"cannot_verify","observation":"redirected to a login page"}`]);
  const r = await harnessWith(driver, llm).check(check, "http://localhost:3000");
  assert.equal(r.executed, false);
  assert.equal(r.passed, false);
});

test("acts then concludes: action is performed before the verdict", async () => {
  const driver = new FakeBrowserDriver({ observations: [obs()] });
  const llm = new QueueLlm([
    `{"action":{"kind":"click","selector":"text=Save"}}`,
    `{"conclusion":"pass","observation":"toast appeared after click"}`,
  ]);
  const r = await harnessWith(driver, llm).check(check, "http://localhost:3000");
  assert.equal(r.passed, true);
  assert.deepEqual(driver.performed[0], { kind: "click", selector: "text=Save" });
});

test("open failure → blocked", async () => {
  const driver = new FakeBrowserDriver({ observations: [obs()], openError: "chromium launch failed" });
  const llm = new QueueLlm([`{"conclusion":"pass"}`]);
  const r = await harnessWith(driver, llm).check(check, "http://localhost:3000");
  assert.equal(r.executed, false);
  assert.match(r.detail, /could not open the app/);
});

test("malformed model reply → blocked", async () => {
  const driver = new FakeBrowserDriver({ observations: [obs()] });
  const llm = new QueueLlm(["not json at all"]);
  const r = await harnessWith(driver, llm).check(check, "http://localhost:3000");
  assert.equal(r.executed, false);
  assert.match(r.detail, /not valid JSON/);
});

test("step budget exhausted (agent never concludes) → blocked", async () => {
  const driver = new FakeBrowserDriver({ observations: [obs()] });
  const llm = new QueueLlm([`{"action":{"kind":"wait","value":"100"}}`]); // always acts, never concludes
  const r = await harnessWith(driver, llm, { maxSteps: 3 }).check(check, "http://localhost:3000");
  assert.equal(r.executed, false);
  assert.match(r.detail, /step budget/);
});

test("no base URL → blocked without opening a browser", async () => {
  const driver = new FakeBrowserDriver({ observations: [obs()] });
  const r = await harnessWith(driver, new QueueLlm([`{"conclusion":"pass"}`])).check(check, undefined);
  assert.equal(r.executed, false);
  assert.equal(driver.opened.length, 0);
});

test("repeated action errors → blocked", async () => {
  const driver = new FakeBrowserDriver({ observations: [obs()], performError: "element not found" });
  const llm = new QueueLlm([`{"action":{"kind":"click","selector":"#missing"}}`]);
  const r = await harnessWith(driver, llm, { maxConsecutiveActionErrors: 2 }).check(check, "http://localhost:3000");
  assert.equal(r.executed, false);
  assert.match(r.detail, /failed actions/);
});

test("storageState (auth) is threaded into the browser session (PR-3)", async () => {
  const driver = new FakeBrowserDriver({ observations: [obs()] });
  const llm = new QueueLlm([`{"conclusion":"pass"}`]);
  await harnessWith(driver, llm, { storageStatePath: "/tmp/auth.json" }).check(check, "http://localhost:3000");
  assert.equal(driver.opened[0]!.opts.storageStatePath, "/tmp/auth.json");
});
