import type { LlmClient } from "../../backends/llm.js";
import { extractJson } from "../../util/json.js";
import type { Evidence } from "../../types.js";
import type { BrowserAction, BrowserDriver, BrowserSession, PageObservation } from "../ui/browserDriver.js";
import type { JourneyCheck, JourneyCheckResult, JourneyHarness } from "./journeyHarness.js";

/**
 * AI-driven journey harness (IN-661, Phase 2).
 *
 * Same principle as the UI harness (IN-606): **the AI is the eyes and hands; VerifyFlow is the
 * judge.** The difference is the journey is *multi-modal and multi-step* — the agent verifies a
 * cross-step product outcome by composing two action kinds across an ordered flow:
 *   - `run`     — execute a backend shell command in the checkout (setup/precondition, downstream
 *                 assertion, DB/CLI check) and observe its exit + output.
 *   - `browser` — drive the live app via the same BrowserDriver the UI harness uses.
 * State accrues across steps (command output + page observations) so e.g. "create via API → see it
 * in the UI" is one journey. Evidence is captured per step (command logs + screenshots).
 *
 * Verdict guardrails are identical to the UI harness — never false-fail:
 *   - The agent may only conclude pass / fail / cannot_verify.
 *   - Anything that isn't a confident, executed `fail` → executed:false → the engine blocks the
 *     criterion (missing capability, action error storm, budget exhausted, malformed reply, or the
 *     agent itself saying cannot_verify). A `fail` must reproduce across independent re-runs.
 */

const SYSTEM = `You are a meticulous end-to-end tester verifying ONE acceptance criterion that spans multiple steps
(setup/precondition → primary flow → downstream result). You have two tools and must reply with STRICT JSON only,
in one of these shapes:
  {"thought":"...","action":{"kind":"run","command":"<shell command run in the repo checkout>"}}
  {"thought":"...","action":{"kind":"browser","browser":{"kind":"navigate|click|type|press|wait","selector":"<css or text=...>","value":"<url|text|key|ms>"}}}
  {"thought":"...","action":{"kind":"poll","poll":{"command":"<shell command>","expectSubstring":"<text that must appear>","timeoutMs":30000,"intervalMs":2000}}}
  {"thought":"...","conclusion":"pass|fail|cannot_verify","observation":"<what across the steps justifies this>"}
Rules:
- Compose the minimum steps needed across backend and browser, then conclude.
- "run" executes a shell command in the checked-out repo (use it for preconditions, DB/API assertions).
- "poll" RE-RUNS a command until its output contains expectSubstring (or its exit matches expectExitCode), or the
  timeout elapses. Use it for DOWNSTREAM / ASYNC results: a webhook delivered, an event consumed, a notification or
  email queued, a row persisted, a job finished. If the signal is NOT observed within the timeout, that is
  cannot_verify (the downstream system may just be slow) — NEVER fail on a poll timeout.
- "browser" drives the live app (only if a base URL is available).
- Also cover, when the criterion implies them: role / account-state VARIATION (re-run the flow as a different
  role/state) and NEIGHBORING REGRESSION (check an adjacent behavior the change should not have broken).
- conclusion "pass": you directly observed the expected end-to-end outcome (including any required downstream signal).
- conclusion "fail": you completed the steps and the expected outcome was clearly ABSENT or wrong. Only when certain,
  and never solely because a poll timed out.
- conclusion "cannot_verify": you cannot reach a confident verdict — a tool is unavailable, a step errored, a poll
  timed out, a login wall, or an ambiguous criterion. When in doubt, choose cannot_verify, NEVER fail.`;

export type AgentConclusion = "pass" | "fail" | "cannot_verify";

export interface CommandOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  evidence?: Evidence[];
}

/** Runs a backend shell command in the checkout. `label` distinguishes steps for evidence/log naming. */
export type CommandExecutor = (command: string, label: string) => Promise<CommandOutcome>;

/** Downstream/async assertion: re-run `command` until it matches, or the timeout elapses. */
export interface PollSpec {
  command: string;
  expectSubstring?: string;
  expectExitCode?: number;
  timeoutMs?: number;
  intervalMs?: number;
}

interface JourneyAction {
  kind: "run" | "browser" | "poll";
  command?: string;
  browser?: BrowserAction;
  poll?: PollSpec;
}

interface AgentReply {
  thought?: string;
  action?: JourneyAction;
  conclusion?: AgentConclusion;
  observation?: string;
}

export interface AgenticJourneyOptions {
  llm: LlmClient;
  /** Run artifact root; command logs and screenshots are written under it. */
  artifactsDir: string;
  /** Backend step executor (shell command in the checkout). Absent → backend steps are unavailable. */
  runCommand?: CommandExecutor;
  /** Browser step driver. Absent (or no base URL) → browser steps are unavailable. */
  driver?: BrowserDriver;
  storageStatePath?: string;
  maxSteps?: number;
  failConfirmations?: number;
  maxConsecutiveActionErrors?: number;
  /** Sleep between poll attempts (injectable so tests don't wait real time). Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock for poll deadlines (injectable for tests). Defaults to Date.now. */
  now?: () => number;
}

// Bounds so a model-supplied poll spec can't hang the run or hammer a command.
const POLL_MAX_TIMEOUT_MS = 120_000;
const POLL_MIN_INTERVAL_MS = 100;
const POLL_MAX_ATTEMPTS = 60;

interface RunOutcome {
  conclusion: AgentConclusion;
  observation: string;
  evidence: Evidence[];
}

export class AgenticJourneyHarness implements JourneyHarness {
  readonly name = "journey-agentic";
  private readonly o: Required<Omit<AgenticJourneyOptions, "runCommand" | "driver" | "storageStatePath">> &
    Pick<AgenticJourneyOptions, "runCommand" | "driver" | "storageStatePath">;

  constructor(opts: AgenticJourneyOptions) {
    this.o = {
      maxSteps: 12,
      failConfirmations: 2,
      maxConsecutiveActionErrors: 3,
      sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
      ...opts,
    };
  }

  async available(): Promise<boolean> {
    if (!(await this.o.llm.available())) return false;
    // At least one execution modality must exist, else every step is unavailable → all blocked.
    const browserOk = this.o.driver ? await this.o.driver.available() : false;
    return Boolean(this.o.runCommand) || browserOk;
  }

  async check(check: JourneyCheck, baseUrl: string | undefined): Promise<JourneyCheckResult> {
    const first = await this.runOnce(check, baseUrl);
    if (first.conclusion !== "fail") return this.toResult(check, first);

    // Anti-flake: a fail must reproduce across independent re-runs, else downgrade to cannot_verify.
    for (let i = 1; i < this.o.failConfirmations; i++) {
      const again = await this.runOnce(check, baseUrl);
      if (again.conclusion !== "fail") {
        return this.toResult(check, {
          conclusion: "cannot_verify",
          observation:
            `fail not reproduced on re-run ${i} (got "${again.conclusion}") — downgraded to cannot_verify ` +
            `to avoid a false fail. First run: ${first.observation}`,
          evidence: [...first.evidence, ...again.evidence],
        });
      }
      first.evidence.push(...again.evidence);
    }
    return this.toResult(check, first);
  }

  /** One full agent loop. Never throws — any error becomes cannot_verify (blocked). */
  private async runOnce(check: JourneyCheck, baseUrl: string | undefined): Promise<RunOutcome> {
    const evidence: Evidence[] = [];
    const history: string[] = [];
    let session: BrowserSession | undefined;
    let lastPage: PageObservation | undefined;
    let consecutiveActionErrors = 0;
    let cmdSeq = 0;

    const fail = (observation: string): RunOutcome => ({ conclusion: "cannot_verify", observation, evidence });

    try {
      for (let step = 0; step < this.o.maxSteps; step++) {
        const reply = await this.ask(check, history, lastPage);
        if (!reply) return fail("model reply was not valid JSON");
        if (reply.conclusion) {
          return { conclusion: reply.conclusion, observation: reply.observation ?? reply.thought ?? "", evidence };
        }
        if (!reply.action) return fail("model neither acted nor concluded");

        const act = reply.action;
        if (act.kind === "run") {
          if (!this.o.runCommand) {
            history.push(`run "${act.command ?? ""}" → unavailable (no checkout / backend executor)`);
            if (++consecutiveActionErrors >= this.o.maxConsecutiveActionErrors) {
              return fail("backend command execution is unavailable (run with --checkout/--workdir)");
            }
            continue;
          }
          const cmd = act.command ?? "";
          const out = await this.o.runCommand(cmd, `journey-cmd-${++cmdSeq}`);
          if (out.evidence) evidence.push(...out.evidence);
          const tail = (out.stdout + (out.stderr ? `\n${out.stderr}` : "")).trim().slice(0, 400);
          history.push(`$ ${cmd} → exit ${out.exitCode}${tail ? `; ${tail}` : ""}`);
          consecutiveActionErrors = out.exitCode === 0 ? 0 : consecutiveActionErrors; // non-zero exit is a finding, not a harness error
        } else if (act.kind === "browser") {
          if (!this.o.driver || !baseUrl) {
            history.push(`browser ${act.browser?.kind ?? ""} → unavailable (no browser driver / base URL)`);
            if (++consecutiveActionErrors >= this.o.maxConsecutiveActionErrors) {
              return fail("browser execution is unavailable (Playwright not installed or no base URL)");
            }
            continue;
          }
          if (!session) {
            try {
              session = await this.o.driver.open(baseUrl, {
                artifactsDir: this.o.artifactsDir,
                storageStatePath: this.o.storageStatePath,
              });
            } catch (err) {
              return fail(`could not open the app at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          if (!act.browser) return fail("browser action missing its `browser` payload");
          const res = await session.perform(act.browser);
          lastPage = await session.observe();
          if (lastPage.screenshotPath) {
            evidence.push({ type: "screenshot", summary: `journey step ${step + 1}`, path: lastPage.screenshotPath });
          }
          history.push(
            `browser ${act.browser.kind} ${act.browser.selector ?? ""} ${act.browser.value ?? ""}`.trim() +
              (res.ok ? "" : ` → error: ${res.error}`),
          );
          if (res.ok) consecutiveActionErrors = 0;
          else if (++consecutiveActionErrors >= this.o.maxConsecutiveActionErrors) {
            return fail(`gave up after ${consecutiveActionErrors} failed browser actions (last: ${res.error})`);
          }
        } else if (act.kind === "poll") {
          if (!this.o.runCommand) {
            history.push(`poll "${act.poll?.command ?? ""}" → unavailable (no checkout / backend executor)`);
            if (++consecutiveActionErrors >= this.o.maxConsecutiveActionErrors) {
              return fail("poll execution is unavailable (run with --checkout/--workdir)");
            }
            continue;
          }
          if (!act.poll?.command) return fail("poll action missing its `poll.command`");
          const spec = act.poll;
          const timeoutMs = Math.min(Math.max(spec.timeoutMs ?? 30_000, 0), POLL_MAX_TIMEOUT_MS);
          const intervalMs = Math.max(spec.intervalMs ?? 2_000, POLL_MIN_INTERVAL_MS);
          // Match on substring when given; otherwise on exit code (default 0).
          const expectExit = spec.expectExitCode ?? (spec.expectSubstring ? undefined : 0);
          const deadline = this.o.now() + timeoutMs;
          let attempts = 0;
          let matched = false;
          let lastOut: CommandOutcome = { exitCode: null, stdout: "", stderr: "" };
          while (attempts < POLL_MAX_ATTEMPTS) {
            attempts++;
            lastOut = await this.o.runCommand(spec.command, `journey-poll-${++cmdSeq}-a${attempts}`);
            const text = lastOut.stdout + (lastOut.stderr ? `\n${lastOut.stderr}` : "");
            const exitOk = expectExit === undefined || lastOut.exitCode === expectExit;
            const subOk = !spec.expectSubstring || text.includes(spec.expectSubstring);
            if (exitOk && subOk) {
              matched = true;
              break;
            }
            if (this.o.now() >= deadline) break;
            await this.o.sleep(intervalMs);
          }
          if (lastOut.evidence) evidence.push(...lastOut.evidence);
          const cond = spec.expectSubstring ? `output contains "${spec.expectSubstring}"` : `exit ${expectExit}`;
          if (matched) {
            history.push(`poll "${spec.command}" → matched (${cond}) after ${attempts} attempt(s)`);
            consecutiveActionErrors = 0;
          } else {
            // Downstream signal not observed within the budget. Surface it as an informative result
            // (NOT an action error): the agent must treat a poll timeout as cannot_verify, never fail.
            history.push(
              `poll "${spec.command}" → NOT observed (${cond}) within ${timeoutMs}ms / ${attempts} attempt(s) ` +
                `— downstream signal absent; this is cannot_verify, never fail`,
            );
          }
        } else {
          return fail(`unknown action kind: ${(act as JourneyAction).kind}`);
        }
      }
      return fail(`step budget (${this.o.maxSteps}) exhausted without a conclusion`);
    } finally {
      if (session) {
        // Flush the session trace as evidence (best-effort) before closing — see the UI harness note.
        try {
          if (session.finalize) evidence.push(...(await session.finalize()));
        } catch {
          /* trace is best-effort evidence */
        }
        await session.close().catch(() => {});
      }
    }
  }

  private async ask(check: JourneyCheck, history: string[], page: PageObservation | undefined): Promise<AgentReply | undefined> {
    const pageBlock = page
      ? [
          ``,
          `CURRENT PAGE:`,
          `url: ${page.url}`,
          `title: ${page.title}`,
          page.consoleErrors.length ? `console errors:\n${page.consoleErrors.join("\n")}` : `console errors: none`,
          `interactive elements:\n${page.domSummary || "(none captured)"}`,
        ]
      : [];
    const tools = [
      `TOOLS AVAILABLE:`,
      `- run (backend shell command): ${this.o.runCommand ? "yes" : "NO (no checkout)"}`,
      `- browser: ${this.o.driver ? "yes (if a base URL is set)" : "NO (Playwright not installed)"}`,
    ];
    const prompt = [
      `ACCEPTANCE CRITERION TO VERIFY (end-to-end, may span steps):\n${check.criterion}`,
      ``,
      ...tools,
      ...pageBlock,
      ``,
      history.length ? `STEPS SO FAR:\n${history.join("\n")}` : `STEPS SO FAR: (none yet)`,
      ``,
      `Decide the next action, or conclude. Reply with strict JSON only.`,
    ].join("\n");

    let raw: string;
    try {
      raw = await this.o.llm.complete({ system: SYSTEM, prompt, task: `journey-check:${check.criterionId}`, tier: "smart" });
    } catch {
      return undefined;
    }
    try {
      return extractJson<AgentReply>(raw);
    } catch {
      return undefined;
    }
  }

  private toResult(check: JourneyCheck, outcome: RunOutcome): JourneyCheckResult {
    if (outcome.conclusion === "cannot_verify") {
      return {
        criterionId: check.criterionId,
        passed: false,
        executed: false, // → verdict engine environment-blocks (never pass, never fail)
        detail: `cannot verify end-to-end: ${outcome.observation}`,
        evidence: outcome.evidence,
      };
    }
    return {
      criterionId: check.criterionId,
      passed: outcome.conclusion === "pass",
      executed: true,
      detail: outcome.observation,
      evidence: outcome.evidence,
    };
  }
}
