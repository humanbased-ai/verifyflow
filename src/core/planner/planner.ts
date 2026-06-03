import type {
  CriteriaModel,
  EvaluationPlan,
  Level,
  PlanStep,
  PrContext,
} from "../../types.js";
import type { MemoryStore } from "../../memory/store.js";
import { adaptCommand, type RepoConfig } from "./repoConfig.js";

const UI_HINTS =
  /\b(click|button|screen|page|render|displays?|visible|browser|UI|form|toast|modal|navigat)/i;
const HIGH_RISK_HINTS =
  /\b(billing|payment|charge|auth|permission|migrat|webhook|integration|checkout|onboarding)/i;

/**
 * Builds the functional evaluation plan:
 *   - environment setup (from repo config)
 *   - one probe step per runnable criterion (reusing a memory test point when one exists)
 *   - a scoped test step over the PR's changed test files (selective execution, not the whole suite)
 *
 * Also recommends escalation when the issue's criteria imply depth beyond the requested level.
 */
export async function buildPlan(
  level: Level,
  criteria: CriteriaModel,
  pr: PrContext,
  cfg: RepoConfig,
  memory: MemoryStore,
): Promise<EvaluationPlan> {
  const steps: PlanStep[] = [];
  const notes: string[] = [`repo config source: ${cfg.source}`];

  // Unknown toolchain: emit no steps and signal environment-blocked. Never guess commands.
  if (cfg.unknown) {
    const reason =
      "Could not determine how to set up/run this repo (no verifyflow.config.json and no " +
      "recognized ecosystem manifest). Add a verifyflow.config.json to run delivery checks.";
    notes.push(reason);
    return {
      level,
      steps,
      notes,
      environmentUnknown: { reason },
      escalationRecommended: recommendEscalation(level, criteria, pr),
    };
  }

  cfg.setup.forEach((command, i) =>
    steps.push({
      id: `setup-${i + 1}`,
      kind: "command",
      description: `environment setup: ${command}`,
      command,
      criterionIds: [],
      reusedTestPoint: false,
    }),
  );

  let probeCount = 0;
  for (const c of criteria.criteria) {
    if (!c.observable) {
      notes.push(`${c.id} marked not observable; will be reported not_evaluable.`);
      continue;
    }
    const reused = await memory.matchTestPoint(pr.repo, c.text);
    const probe = reused?.probe ?? c.probe;
    if (!probe) continue;
    probeCount++;
    steps.push({
      id: `probe-${c.id}`,
      kind: "command",
      description: reused
        ? `reused memory test point for ${c.id}`
        : `probe for ${c.id}`,
      command: adaptCommand(probe.command, cfg),
      cwd: probe.cwd,
      criterionIds: [c.id],
      expectSubstring: probe.expectSubstring,
      expectExitCode: probe.expectExitCode ?? 0,
      reusedTestPoint: Boolean(reused),
    });
  }
  if (probeCount > 0) notes.push(`${probeCount} runnable probe(s) planned.`);

  // Selective execution: only the changed test files, not the whole suite.
  const changedTests = pr.changedFiles
    .map((f) => f.path)
    .filter((p) => /(^|\/)tests?\//.test(p) || /(_test|test_|\.test|\.spec)\.[a-z]+$/.test(p));
  const allCriterionIds = criteria.criteria.map((c) => c.id);
  const keywords = deriveTestKeywords(criteria);
  const scopedTest = cfg.testForFiles(changedTests, keywords);
  if (scopedTest) {
    if (keywords.length)
      notes.push(`selective execution: narrowed scoped tests to keywords [${keywords.join(", ")}].`);
    steps.push({
      id: "tests-scoped",
      kind: "command",
      description: `scoped tests for changed test files: ${changedTests.join(", ")}`,
      command: scopedTest,
      criterionIds: allCriterionIds,
      expectExitCode: 0,
      reusedTestPoint: false,
    });
  } else {
    notes.push(
      "No changed test files detected; relying on probes only (no full-suite run by default).",
    );
  }

  const escalationRecommended = recommendEscalation(level, criteria, pr);

  return { level, steps, notes, escalationRecommended };
}

const STOPWORDS = new Set([
  "value", "prints", "print", "exits", "exit", "should", "package", "metadata",
  "hardcoded", "read", "from", "with", "that", "this", "when", "then", "have", "the",
  "and", "for", "are", "not", "version",
]);

/**
 * Derive selective-execution keywords from the criteria. Prefers CLI flags named in probes
 * (e.g. `--version` -> "version"), then distinctive lowercase tokens from the criterion text.
 * Used to narrow pytest runs with `-k` so one hung/irrelevant test cannot stall verification.
 */
export function deriveTestKeywords(criteria: CriteriaModel): string[] {
  const out = new Set<string>();
  for (const c of criteria.criteria) {
    const flags = [...(c.probe?.command ?? "").matchAll(/--([a-z][\w-]+)/g)].map((m) => m[1]!);
    for (const f of flags) out.add(f.toLowerCase());
  }
  if (out.size === 0) {
    for (const c of criteria.criteria) {
      for (const tok of c.text.toLowerCase().match(/[a-z]{5,}/g) ?? []) {
        if (!STOPWORDS.has(tok)) out.add(tok);
        if (out.size >= 4) break;
      }
      if (out.size >= 4) break;
    }
  }
  return [...out].slice(0, 4);
}

function recommendEscalation(
  level: Level,
  criteria: CriteriaModel,
  pr: PrContext,
): EvaluationPlan["escalationRecommended"] {
  const text = criteria.criteria.map((c) => c.text).join(" ");
  if (level === "functional" && UI_HINTS.test(text)) {
    return { toLevel: "ui", reason: "criteria mention user-visible behavior" };
  }
  const touched = pr.changedFiles.map((f) => f.path).join(" ");
  if (level !== "journey" && HIGH_RISK_HINTS.test(text + " " + touched)) {
    return {
      toLevel: "journey",
      reason: "criteria or changed files touch high-risk areas (billing/auth/migrations/integrations)",
    };
  }
  return undefined;
}
