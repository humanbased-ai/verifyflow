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
