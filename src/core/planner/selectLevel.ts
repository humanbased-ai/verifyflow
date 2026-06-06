import type { CriteriaModel, Level, PrContext } from "../../types.js";
import { UI_HINTS, HIGH_RISK_HINTS } from "./planner.js";

/** Environment readiness for the browser-backed levels, probed by the CLI before the run. */
export interface AutoLevelEnv {
  /** A running app URL was resolved (explicit --base-url or a discovered preview). */
  appAvailable: boolean;
  /** The Playwright browser driver is installed. */
  playwrightAvailable: boolean;
}

export interface LevelSelection {
  /** The level VerifyFlow will actually run. */
  level: Level;
  /** The level the ticket implied, before any environment downgrade. */
  needed: Level;
  /** Trace of the decision (selected level, why, any downgrade) — surfaced in the plan notes. */
  notes: string[];
}

/**
 * Resolve `--level auto` into a concrete level (IN-680).
 *
 * Two stages, in order:
 *   1. What does the TICKET need? Pick the highest level any observable criterion implies — a
 *      criterion classified `journey` (or high-risk hints in the criteria/changed files) → journey;
 *      a `ui`/`integration` criterion (or UI hints) → ui; otherwise functional.
 *   2. Can the ENVIRONMENT run it? ui/journey need a running app + Playwright; if either is missing
 *      we DOWNGRADE to functional and say why, rather than silently blocking every browser
 *      criterion.
 *
 * The decision is never silent: every branch records a note the report surfaces.
 */
export function selectLevel(
  criteria: CriteriaModel,
  pr: PrContext,
  env: AutoLevelEnv,
): LevelSelection {
  const observable = criteria.criteria.filter((c) => c.observable);
  const methods = new Set(observable.map((c) => c.method));
  const text = observable.map((c) => c.text).join(" ");
  const touched = pr.changedFiles.map((f) => f.path).join(" ");

  let needed: Level = "functional";
  let reason = "criteria look backend/CLI-checkable";
  if (methods.has("journey") || HIGH_RISK_HINTS.test(`${text} ${touched}`)) {
    needed = "journey";
    reason = methods.has("journey")
      ? "a criterion is classified journey (multi-step end-to-end)"
      : "criteria or changed files touch high-risk areas (billing/auth/migrations/integrations)";
  } else if (methods.has("ui") || methods.has("integration") || UI_HINTS.test(text)) {
    needed = "ui";
    reason =
      methods.has("ui") || methods.has("integration")
        ? "a criterion is classified ui/integration (user-visible behavior)"
        : "criteria mention user-visible behavior";
  }

  const notes = [`auto: selected ${needed} — ${reason}.`];

  if (needed === "ui" || needed === "journey") {
    const missing: string[] = [];
    if (!env.appAvailable) missing.push("no running app URL (pass --base-url or expose a preview)");
    if (!env.playwrightAvailable) missing.push("Playwright not installed (npm i -D playwright)");
    if (missing.length > 0) {
      notes.push(
        `auto: downgraded ${needed} → functional because ${missing.join(" and ")}. ` +
          `Resolve the above to run ${needed}-level checks.`,
      );
      return { level: "functional", needed, notes };
    }
  }

  return { level: needed, needed, notes };
}
