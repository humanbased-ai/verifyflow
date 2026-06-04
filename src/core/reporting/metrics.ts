import type { QualityEvent } from "../../types.js";

/**
 * Quality-intelligence metrics (IN-557, docs/quality-intelligence.md). Computed over the
 * accumulated event log so VerifyFlow's value compounds across runs: pass/not-evaluable/reuse
 * rates, failure hot-spots by component and category, and the slowest harnesses.
 */
export interface QualityMetrics {
  runs: number;
  criteria: number;
  passRate: number;
  notEvaluableRate: number;
  reuseRate: number;
  verdicts: Record<string, number>;
  failuresByComponent: Record<string, number>;
  failuresByCategory: Record<string, number>;
  byLevel: Record<string, { criteria: number; pass: number }>;
  slowest: Array<{ component: string; criterionId?: string; durationMs: number }>;
  /** (component, failure_category) pairs seen more than once — systemic problems to flag. */
  repeatedFailurePatterns: Array<{ component: string; category: string; count: number }>;
}

const rate = (num: number, den: number) => (den === 0 ? 0 : num / den);
const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);

/** Scope filters for `vf report` (IN-625): metrics can be narrowed instead of always aggregating. */
export interface MetricsFilter {
  /** ISO date/datetime lower bound (inclusive) on the event timestamp. */
  since?: string;
  /** Exact owner/repo match. */
  repo?: string;
  /** Exact evaluation level match. */
  level?: string;
}

/**
 * Restrict the event log to a scope before computing metrics. An unparsable `since` is ignored
 * (treated as no lower bound) so a typo can't silently drop every event.
 */
export function filterEvents(events: QualityEvent[], filter: MetricsFilter = {}): QualityEvent[] {
  const sinceMs = filter.since ? Date.parse(filter.since) : NaN;
  return events.filter((e) => {
    if (filter.repo && e.repo !== filter.repo) return false;
    if (filter.level && e.level !== filter.level) return false;
    if (!Number.isNaN(sinceMs)) {
      const ts = Date.parse(e.ts);
      if (Number.isNaN(ts) || ts < sinceMs) return false;
    }
    return true;
  });
}

/** Per-day run-verdict counts, oldest first — a simple over-time trend for `vf report`. */
export function computeTrend(events: QualityEvent[]): Array<{ date: string; runs: number; verdicts: Record<string, number> }> {
  const byDay = new Map<string, { runs: number; verdicts: Record<string, number> }>();
  for (const e of events) {
    if (e.event_type !== "run_verdict") continue;
    const date = e.ts.slice(0, 10);
    if (!date) continue;
    const day = byDay.get(date) ?? { runs: 0, verdicts: {} };
    day.runs++;
    if (typeof e.result === "string") bump(day.verdicts, e.result);
    byDay.set(date, day);
  }
  return [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, v]) => ({ date, ...v }));
}

export function computeMetrics(events: QualityEvent[]): QualityMetrics {
  const crit = events.filter((e) => e.event_type === "acceptance_criterion_result");
  const runs = events.filter((e) => e.event_type === "run_verdict");

  let pass = 0;
  let notEval = 0;
  let reused = 0;
  const verdicts: Record<string, number> = {};
  const failuresByComponent: Record<string, number> = {};
  const failuresByCategory: Record<string, number> = {};
  const byLevel: Record<string, { criteria: number; pass: number }> = {};
  const patternCounts = new Map<string, { component: string; category: string; count: number }>();

  for (const e of crit) {
    if (e.result === "pass") pass++;
    if (e.result === "not_evaluable") notEval++;
    if (e.reused) reused++;

    const lvl = (byLevel[e.level] ??= { criteria: 0, pass: 0 });
    lvl.criteria++;
    if (e.result === "pass") lvl.pass++;

    if (e.result === "fail" || e.result === "blocked") {
      const component = e.component ?? "unknown";
      bump(failuresByComponent, component);
      if (e.failure_category) {
        bump(failuresByCategory, e.failure_category);
        const key = `${component}::${e.failure_category}`;
        const p = patternCounts.get(key) ?? { component, category: e.failure_category, count: 0 };
        p.count++;
        patternCounts.set(key, p);
      }
    }
  }

  for (const r of runs) if (typeof r.result === "string") bump(verdicts, r.result);

  const slowest = crit
    .filter((e) => typeof e.duration_ms === "number")
    .map((e) => ({ component: e.component ?? "unknown", criterionId: e.criterion_id, durationMs: e.duration_ms! }))
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 5);

  return {
    runs: runs.length,
    criteria: crit.length,
    passRate: rate(pass, crit.length),
    notEvaluableRate: rate(notEval, crit.length),
    reuseRate: rate(reused, crit.length),
    verdicts,
    failuresByComponent,
    failuresByCategory,
    byLevel,
    slowest,
    repeatedFailurePatterns: [...patternCounts.values()]
      .filter((p) => p.count > 1)
      .sort((a, b) => b.count - a.count),
  };
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const table = (m: Record<string, number>) =>
  Object.entries(m)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n") || "- (none)";

/** Render a per-day verdict trend as markdown (appended to the report when `--trend` is passed). */
export function renderTrendMarkdown(
  trend: Array<{ date: string; runs: number; verdicts: Record<string, number> }>,
): string {
  const lines = ["## Over-time trend (runs/day)"];
  if (trend.length === 0) {
    lines.push("- (no run data)");
    return lines.join("\n") + "\n";
  }
  for (const d of trend) {
    const v = Object.entries(d.verdicts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}=${n}`)
      .join(", ");
    lines.push(`- ${d.date}: ${d.runs} run(s)${v ? ` (${v})` : ""}`);
  }
  return lines.join("\n") + "\n";
}

export function renderMetricsMarkdown(m: QualityMetrics): string {
  const lines: string[] = [];
  lines.push("# VerifyFlow quality intelligence");
  lines.push("");
  lines.push(`> ${m.runs} run(s), ${m.criteria} criterion result(s).`);
  lines.push("");
  lines.push("## Rates");
  lines.push(`- acceptance-criterion pass rate: ${pct(m.passRate)}`);
  lines.push(`- not-evaluable rate: ${pct(m.notEvaluableRate)}`);
  lines.push(`- memory reuse rate: ${pct(m.reuseRate)}`);
  lines.push("");
  lines.push("## Run verdicts");
  lines.push(table(m.verdicts));
  lines.push("");
  lines.push("## Failures by component");
  lines.push(table(m.failuresByComponent));
  lines.push("");
  lines.push("## Failures by category");
  lines.push(table(m.failuresByCategory));
  lines.push("");
  lines.push("## Repeated failure patterns (systemic)");
  lines.push(
    m.repeatedFailurePatterns.map((p) => `- ${p.component} — ${p.category}: ${p.count}×`).join("\n") ||
      "- (none repeated)",
  );
  lines.push("");
  lines.push("## Slowest harnesses");
  lines.push(
    m.slowest.map((s) => `- ${s.component}${s.criterionId ? ` (${s.criterionId})` : ""}: ${s.durationMs}ms`).join("\n") ||
      "- (no timing data)",
  );
  return lines.join("\n") + "\n";
}
