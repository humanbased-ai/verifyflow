import type { Evidence, HarnessResult } from "../../types.js";

/**
 * UI evaluation boundary (IN-559).
 *
 * VerifyFlow owns the harness/policy/evidence contract; the browser is an interchangeable
 * execution backend — exactly like the LLM boundary (FallbackLlm vs ClaudeCliClient). This file
 * defines the seam and ships two drivers:
 *   - UnavailableUiHarness: the production default until a real browser driver is wired. Every
 *     check reports "not executed" so criteria become environment-blocked (never a false pass).
 *   - FakeUiHarness: a deterministic driver for tests and offline orchestration, returning
 *     pre-programmed pass/fail outcomes with stub screenshot evidence.
 * A real PlaywrightUiHarness is the follow-up — it implements this same interface.
 */

export interface UiCheck {
  criterionId: string;
  /** The acceptance-criterion text describing the user-visible behavior to verify. */
  criterion: string;
}

export interface UiCheckResult {
  criterionId: string;
  /** True when the user-visible behavior was observed; false when it was refuted. */
  passed: boolean;
  /** True when a browser actually ran the check; false when no driver was available. */
  executed: boolean;
  /** Human-readable observation (what the browser saw). */
  detail: string;
  evidence: Evidence[];
}

export interface UiHarness {
  readonly name: string;
  available(): Promise<boolean>;
  /** Drive the app (served at baseUrl) to verify one acceptance criterion. */
  check(check: UiCheck, baseUrl: string | undefined): Promise<UiCheckResult>;
}

/** Map a UiCheckResult onto the HarnessResult the verdict engine already understands. */
export function toHarnessResult(r: UiCheckResult): HarnessResult {
  return {
    stepId: `probe-${r.criterionId}`,
    command: `ui-check: ${r.criterionId}`,
    exitCode: r.executed ? (r.passed ? 0 : 1) : null,
    stdout: r.detail,
    stderr: "",
    durationMs: 0,
    executed: r.executed,
    timedOut: false,
    evidence: r.evidence,
  };
}

/** Production default: no browser wired yet. Reports not-executed so criteria block, never pass. */
export class UnavailableUiHarness implements UiHarness {
  readonly name = "ui-unavailable";
  async available(): Promise<boolean> {
    return false;
  }
  async check(check: UiCheck): Promise<UiCheckResult> {
    return {
      criterionId: check.criterionId,
      passed: false,
      executed: false,
      detail:
        "No UI browser driver is wired yet (Playwright adapter is an IN-559 follow-up). " +
        "This criterion needs browser-backed evaluation and cannot be verified here.",
      evidence: [],
    };
  }
}

/** Deterministic driver for tests/offline orchestration. `outcomes` maps criterionId -> pass. */
export class FakeUiHarness implements UiHarness {
  readonly name = "ui-fake";
  constructor(private readonly outcomes: Record<string, boolean>) {}
  async available(): Promise<boolean> {
    return true;
  }
  async check(check: UiCheck): Promise<UiCheckResult> {
    const passed = this.outcomes[check.criterionId] ?? false;
    return {
      criterionId: check.criterionId,
      passed,
      executed: true,
      detail: passed ? "Observed the expected user-visible behavior." : "Expected behavior was not observed.",
      evidence: [
        { type: "screenshot", summary: `screenshot for ${check.criterionId}`, path: `ui-${check.criterionId}.png` },
      ],
    };
  }
}
