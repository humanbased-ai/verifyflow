import type { Evidence, HarnessResult } from "../../types.js";

/**
 * Journey (end-to-end) evaluation boundary (IN-659 / IN-660 Phase 1).
 *
 * Mirrors the UI seam (IN-559): VerifyFlow owns the harness/policy/evidence contract; the
 * multi-step execution engine is an interchangeable backend behind this interface. Phase 1 ships
 * the seam plus two drivers — the real orchestration (compose functional probes + ui browser
 * checks across ordered steps) lands in Phase 2 (IN-661):
 *   - UnavailableJourneyHarness: the production default until the executor is wired. Every check
 *     reports "not executed" so journey criteria become environment-blocked (never a false pass).
 *   - FakeJourneyHarness: a deterministic driver for tests and offline orchestration.
 */

export interface JourneyCheck {
  criterionId: string;
  /** The acceptance-criterion text describing the cross-step product outcome to verify. */
  criterion: string;
}

export interface JourneyCheckResult {
  criterionId: string;
  /** True when the end-to-end outcome was observed; false when it was refuted. */
  passed: boolean;
  /** True when the journey was actually executed; false when no executor was available. */
  executed: boolean;
  /** Human-readable observation (what the journey run saw across its steps). */
  detail: string;
  evidence: Evidence[];
}

export interface JourneyHarness {
  readonly name: string;
  available(): Promise<boolean>;
  /** Drive the multi-step journey (app served at baseUrl) to verify one acceptance criterion. */
  check(check: JourneyCheck, baseUrl: string | undefined): Promise<JourneyCheckResult>;
}

/** Map a JourneyCheckResult onto the HarnessResult the verdict engine already understands. */
export function toHarnessResult(r: JourneyCheckResult): HarnessResult {
  return {
    stepId: `probe-${r.criterionId}`,
    command: `journey-check: ${r.criterionId}`,
    exitCode: r.executed ? (r.passed ? 0 : 1) : null,
    stdout: r.detail,
    stderr: "",
    durationMs: 0,
    executed: r.executed,
    timedOut: false,
    evidence: r.evidence,
  };
}

/** Production default: no journey executor wired yet. Reports not-executed so criteria block, never pass. */
export class UnavailableJourneyHarness implements JourneyHarness {
  readonly name = "journey-unavailable";
  async available(): Promise<boolean> {
    return false;
  }
  async check(check: JourneyCheck): Promise<JourneyCheckResult> {
    return {
      criterionId: check.criterionId,
      passed: false,
      executed: false,
      detail:
        "No journey executor is wired yet (the multi-step orchestrator is an IN-661 / Phase 2 " +
        "follow-up). This criterion needs end-to-end, cross-step evaluation and cannot be verified here.",
      evidence: [],
    };
  }
}

/** Deterministic driver for tests/offline orchestration. `outcomes` maps criterionId -> pass. */
export class FakeJourneyHarness implements JourneyHarness {
  readonly name = "journey-fake";
  constructor(private readonly outcomes: Record<string, boolean>) {}
  async available(): Promise<boolean> {
    return true;
  }
  async check(check: JourneyCheck): Promise<JourneyCheckResult> {
    const passed = this.outcomes[check.criterionId] ?? false;
    return {
      criterionId: check.criterionId,
      passed,
      executed: true,
      detail: passed
        ? "Observed the expected end-to-end outcome across the journey steps."
        : "Expected end-to-end outcome was not observed.",
      evidence: [
        { type: "screenshot", summary: `journey trace for ${check.criterionId}`, path: `journey-${check.criterionId}.png` },
      ],
    };
  }
}
