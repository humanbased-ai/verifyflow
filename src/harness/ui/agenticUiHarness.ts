import type { LlmClient } from "../../backends/llm.js";
import { extractJson } from "../../util/json.js";
import type { Evidence } from "../../types.js";
import type { BrowserAction, BrowserDriver, BrowserSession, PageObservation } from "./browserDriver.js";
import type { UiCheck, UiCheckResult, UiHarness } from "./uiHarness.js";

/**
 * AI-driven UI harness (IN-606, PR-2).
 *
 * Design principle: **the AI is the eyes and hands; VerifyFlow is the judge.** An LLM looks at
 * the page (screenshot summary + DOM), decides the next browser action, and eventually concludes
 * whether the acceptance criterion's user-visible behavior is present. VerifyFlow keeps the
 * verdict authority and applies a deliberately conservative mapping (below) so a confused agent
 * can never sink a good PR.
 *
 * Verdict guardrails (the whole point — never false-fail):
 *   - The agent may only conclude `pass`, `fail`, or `cannot_verify`.
 *   - Anything that isn't a confident, executed `fail` maps to executed:false → the verdict engine
 *     environment-blocks the criterion (never fail): launch/navigation error, a console error
 *     storm, the step budget exhausted with no conclusion, a malformed model reply, or the agent
 *     itself saying `cannot_verify` (element-not-found / timeout / looks-like-login-wall).
 *   - A `fail` is re-confirmed by independent re-runs (anti-flake). It survives only if every run
 *     agrees `fail`; one disagreement downgrades it to cannot_verify (blocked). Mirrors the
 *     functional layer's authoritative-vs-corroborating rule for AI-invented probes.
 */

const SYSTEM = `You are a meticulous UI tester driving a real browser to verify ONE acceptance criterion.
Each turn you receive the current page (URL, title, a summary of interactive elements, recent console errors).
Reply with STRICT JSON and nothing else, in one of two shapes:
  {"thought":"...","action":{"kind":"navigate|click|type|press|wait","selector":"<css or text=...>","value":"<url|text|key|ms>"}}
  {"thought":"...","conclusion":"pass|fail|cannot_verify","observation":"<what you saw that justifies this>"}
Rules:
- Take the minimum actions needed, then conclude.
- conclusion "pass": you directly observed the expected behavior.
- conclusion "fail": you took the steps and the expected behavior was clearly ABSENT or wrong. Only when certain.
- conclusion "cannot_verify": you cannot reach a confident verdict — element not found, timeout, a login wall,
  ambiguous criterion, or anything blocking. When in doubt, choose cannot_verify, NEVER fail.`;

export type AgentConclusion = "pass" | "fail" | "cannot_verify";

interface AgentReply {
  thought?: string;
  action?: BrowserAction;
  conclusion?: AgentConclusion;
  observation?: string;
}

export interface AgenticUiOptions {
  driver: BrowserDriver;
  llm: LlmClient;
  /** Run artifact root; screenshots are written under it by the driver. */
  artifactsDir: string;
  storageStatePath?: string;
  /** Max action turns before giving up with cannot_verify (blocked). */
  maxSteps?: number;
  /** Independent runs that must all agree before a `fail` is trusted (anti-flake). */
  failConfirmations?: number;
  /** Abort a single observation/console history that looks like a hard failure. */
  maxConsecutiveActionErrors?: number;
}

interface RunOutcome {
  conclusion: AgentConclusion;
  observation: string;
  evidence: Evidence[];
}

export class AgenticUiHarness implements UiHarness {
  readonly name = "ui-agentic";
  private readonly o: Required<Omit<AgenticUiOptions, "storageStatePath">> & { storageStatePath?: string };

  constructor(opts: AgenticUiOptions) {
    this.o = {
      maxSteps: 8,
      failConfirmations: 2,
      maxConsecutiveActionErrors: 3,
      storageStatePath: undefined,
      ...opts,
    };
  }

  async available(): Promise<boolean> {
    return (await this.o.driver.available()) && (await this.o.llm.available());
  }

  async check(check: UiCheck, baseUrl: string | undefined): Promise<UiCheckResult> {
    if (!baseUrl) {
      return this.blocked(check, "no base URL resolved for the app (cannot open a browser)");
    }

    // First pass.
    const first = await this.runOnce(check, baseUrl);
    if (first.conclusion !== "fail") {
      return this.toResult(check, first);
    }

    // Anti-flake: a fail must be reproduced by every independent re-run, else it's not trustworthy.
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

  /** One full agent loop over a fresh browser session. Never throws — errors become cannot_verify. */
  private async runOnce(check: UiCheck, baseUrl: string): Promise<RunOutcome> {
    let session: BrowserSession;
    const evidence: Evidence[] = [];
    try {
      session = await this.o.driver.open(baseUrl, {
        artifactsDir: this.o.artifactsDir,
        storageStatePath: this.o.storageStatePath,
      });
    } catch (err) {
      return {
        conclusion: "cannot_verify",
        observation: `could not open the app at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
        evidence,
      };
    }

    try {
      const history: string[] = [];
      let consecutiveActionErrors = 0;

      for (let step = 0; step < this.o.maxSteps; step++) {
        const obs = await session.observe();
        if (obs.screenshotPath) {
          evidence.push({ type: "screenshot", summary: `ui step ${step + 1}`, path: obs.screenshotPath });
        }

        const reply = await this.ask(check, obs, history);
        if (!reply) {
          return { conclusion: "cannot_verify", observation: "model reply was not valid JSON", evidence };
        }

        if (reply.conclusion) {
          return { conclusion: reply.conclusion, observation: reply.observation ?? reply.thought ?? "", evidence };
        }

        if (!reply.action) {
          return { conclusion: "cannot_verify", observation: "model neither acted nor concluded", evidence };
        }

        const res = await session.perform(reply.action);
        history.push(
          `${reply.action.kind} ${reply.action.selector ?? ""} ${reply.action.value ?? ""}`.trim() +
            (res.ok ? "" : ` → error: ${res.error}`),
        );
        if (res.ok) {
          consecutiveActionErrors = 0;
        } else if (++consecutiveActionErrors >= this.o.maxConsecutiveActionErrors) {
          return {
            conclusion: "cannot_verify",
            observation: `gave up after ${consecutiveActionErrors} failed actions (last: ${res.error})`,
            evidence,
          };
        }
      }
      return {
        conclusion: "cannot_verify",
        observation: `step budget (${this.o.maxSteps}) exhausted without a conclusion`,
        evidence,
      };
    } finally {
      await session.close().catch(() => {});
    }
  }

  private async ask(check: UiCheck, obs: PageObservation, history: string[]): Promise<AgentReply | undefined> {
    const prompt = [
      `ACCEPTANCE CRITERION TO VERIFY:\n${check.criterion}`,
      ``,
      `CURRENT PAGE:`,
      `url: ${obs.url}`,
      `title: ${obs.title}`,
      obs.consoleErrors.length ? `console errors:\n${obs.consoleErrors.join("\n")}` : `console errors: none`,
      `interactive elements:\n${obs.domSummary || "(none captured)"}`,
      ``,
      history.length ? `ACTIONS SO FAR:\n${history.join("\n")}` : `ACTIONS SO FAR: (none yet)`,
      ``,
      `Decide the next action, or conclude. Reply with strict JSON only.`,
    ].join("\n");

    let raw: string;
    try {
      raw = await this.o.llm.complete({ system: SYSTEM, prompt, task: `ui-check:${check.criterionId}` });
    } catch {
      return undefined;
    }
    try {
      return extractJson<AgentReply>(raw);
    } catch {
      return undefined;
    }
  }

  private toResult(check: UiCheck, outcome: RunOutcome): UiCheckResult {
    if (outcome.conclusion === "cannot_verify") {
      // executed:false → the verdict engine environment-blocks (never pass, never fail).
      return {
        criterionId: check.criterionId,
        passed: false,
        executed: false,
        detail: `cannot verify via browser: ${outcome.observation}`,
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

  private blocked(check: UiCheck, reason: string): UiCheckResult {
    return { criterionId: check.criterionId, passed: false, executed: false, detail: reason, evidence: [] };
  }
}
