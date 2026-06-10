import { promises as fs } from "node:fs";
import path from "node:path";
import type { MemoryStore, FeedbackRecord } from "../memory/store.js";
import type { LlmClient } from "../backends/llm.js";
import type { Probe, RunReport } from "../types.js";
import { extractJson } from "../util/json.js";
import { runDirFor, isUnsafeRunId } from "./inspect.js";

/**
 * `vf feedback` (IN-792): the human correction channel. When VerifyFlow misjudges a criterion
 * (a false-positive fail), the operator records it once; subsequent runs downgrade the matching
 * criterion to `blocked` instead of re-flagging it. Pure logic, separated from the CLI wrapper so
 * it is unit-testable against a real on-disk MemoryStore without spawning a process.
 *
 * Subcommands:
 *   vf feedback <runId> --criterion <id> --false-positive [--note <text>]
 *   vf feedback ls [--repo <o/r>]
 *   vf feedback clear [--repo <o/r>] [--yes]
 */

export interface RecordResult {
  ok: boolean;
  text: string;
  record?: FeedbackRecord;
  repo?: string;
}

export interface RunSummary {
  runId: string;
  repo: string;
  prNumber: number;
  issue: string;
  finishedAt: string;
  /** Criteria that did not pass cleanly — the candidates worth flagging (fail / partial). */
  failed: Array<{ criterionId: string; criterion: string; result: string }>;
}

/**
 * Summarize recent runs under `<outputRoot>/runs/`, newest first, for the interactive picker and
 * `--pr` resolution. Reads each run's report.json; runs without one (or unreadable) are skipped.
 */
export async function listRecentRuns(outputRoot: string, limit = 10): Promise<RunSummary[]> {
  const runsDir = path.join(outputRoot, "runs");
  let entries: string[];
  try {
    entries = (await fs.readdir(runsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const summaries: RunSummary[] = [];
  for (const runId of entries) {
    try {
      const report = JSON.parse(await fs.readFile(path.join(runsDir, runId, "report.json"), "utf8")) as RunReport;
      summaries.push({
        runId,
        repo: report.request.repo,
        prNumber: report.request.prNumber,
        issue: report.issue?.key ?? "",
        finishedAt: report.finishedAt ?? "",
        failed: report.criterionResults
          .filter((c) => c.result === "fail" || c.result === "partial")
          .map((c) => ({ criterionId: c.criterionId, criterion: c.criterion, result: c.result })),
      });
    } catch {
      /* skip runs without a readable report.json */
    }
  }
  // Newest first by finishedAt (ISO strings sort lexicographically); fall back to runId.
  summaries.sort((a, b) => (b.finishedAt || b.runId).localeCompare(a.finishedAt || a.runId));
  return summaries.slice(0, limit);
}

/** Resolve the most recent run id for a given PR number, or undefined if none is found. */
export async function latestRunForPr(outputRoot: string, prNumber: number): Promise<string | undefined> {
  const runs = await listRecentRuns(outputRoot, 1000);
  return runs.find((r) => r.prNumber === prNumber)?.runId;
}

/**
 * Resolve a run's stored report, locate the criterion by id, and persist a false-positive record
 * (keyed by the criterion's text + the run's repo). Reads only what a prior `vf run` already wrote.
 */
export async function recordFalsePositiveFromRun(
  store: MemoryStore,
  outputRoot: string,
  runId: string,
  criterionId: string,
  now: string,
  note?: string,
): Promise<RecordResult> {
  if (isUnsafeRunId(runId)) {
    return { ok: false, text: `feedback: "${runId}" is not a valid run id (must be a single run directory name).` };
  }
  const file = path.join(runDirFor(outputRoot, runId), "report.json");
  let report: RunReport;
  try {
    report = JSON.parse(await fs.readFile(file, "utf8")) as RunReport;
  } catch {
    return { ok: false, text: `feedback: no report.json for run "${runId}" under ${path.join(outputRoot, "runs")}.` };
  }
  const cr = report.criterionResults.find((c) => c.criterionId === criterionId);
  if (!cr) {
    const ids = report.criterionResults.map((c) => c.criterionId).join(", ");
    return { ok: false, text: `feedback: run "${runId}" has no criterion "${criterionId}" (have: ${ids}).` };
  }
  const repo = report.request.repo;
  const record: FeedbackRecord = { kind: "false_positive", criterionText: cr.criterion, note, runId, createdAt: now };
  await store.recordFeedback(repo, record);
  return {
    ok: true,
    repo,
    record,
    text:
      `feedback: recorded ${criterionId} ("${cr.criterion.slice(0, 60)}${cr.criterion.length > 60 ? "…" : ""}") ` +
      `as a false positive for ${repo}. Future runs will downgrade a matching criterion to blocked.`,
  };
}

/**
 * Set a corrected probe for a criterion (IN-808). Resolves the criterion text + repo from the run's
 * report.json and stores it as a reusable, authoritative test point, so the next `vf run` runs this
 * probe for the matching criterion and produces a real pass/fail with evidence (not just `blocked`).
 */
export async function setProbeFromRun(
  store: MemoryStore,
  outputRoot: string,
  runId: string,
  criterionId: string,
  probe: Probe,
  now: string,
): Promise<RecordResult> {
  if (isUnsafeRunId(runId)) {
    return { ok: false, text: `feedback: "${runId}" is not a valid run id (must be a single run directory name).` };
  }
  const file = path.join(runDirFor(outputRoot, runId), "report.json");
  let report: RunReport;
  try {
    report = JSON.parse(await fs.readFile(file, "utf8")) as RunReport;
  } catch {
    return { ok: false, text: `feedback: no report.json for run "${runId}" under ${path.join(outputRoot, "runs")}.` };
  }
  const cr = report.criterionResults?.find((c) => c.criterionId === criterionId);
  if (!cr) {
    const ids = (report.criterionResults ?? []).map((c) => c.criterionId).join(", ");
    return { ok: false, text: `feedback: run "${runId}" has no criterion "${criterionId}" (have: ${ids}).` };
  }
  const repo = report.request.repo;
  await store.upsertTestPoint({ repo, component: "", criterionText: cr.criterion, method: "backend", probe, now });
  const exp = [
    probe.expectExitCode !== undefined ? `exit ${probe.expectExitCode}` : "",
    probe.expectSubstring ? `output contains "${probe.expectSubstring}"` : "",
  ].filter(Boolean).join(", ");
  return {
    ok: true,
    repo,
    text:
      `feedback: set probe for ${criterionId} on ${repo} → \`${probe.command}\`${exp ? ` (expect ${exp})` : ""}.\n` +
      `Future runs will run this probe for that criterion — it can now pass with evidence, not just blocked.`,
  };
}

export interface ProbeSuggestion {
  ok: boolean;
  text: string;
  repo?: string;
  criterionText?: string;
  /** The synthesized probe. `fromTicket` is intentionally NOT set — the caller sets it after the human confirms. */
  probe?: Probe;
  rationale?: string;
}

/**
 * Synthesize a corrected probe from an operator's natural-language description (IN-808). The
 * operator knows the criterion was misjudged and roughly what *should* happen, but not the exact
 * command — the model combines the description with the run's stored context (criterion text, the
 * bad probe that ran and its outcome) into a concrete `command` + expectations. The suggestion is
 * NOT persisted here: a wrong authoritative probe is worse than none (its failure is a real product
 * `fail`), so the caller must show it to the human and only persist on confirmation.
 */
export async function suggestProbeFromRun(
  llm: LlmClient,
  outputRoot: string,
  runId: string,
  criterionId: string,
  describe: string,
): Promise<ProbeSuggestion> {
  if (isUnsafeRunId(runId)) {
    return { ok: false, text: `feedback: "${runId}" is not a valid run id (must be a single run directory name).` };
  }
  const file = path.join(runDirFor(outputRoot, runId), "report.json");
  let report: RunReport;
  try {
    report = JSON.parse(await fs.readFile(file, "utf8")) as RunReport;
  } catch {
    return { ok: false, text: `feedback: no report.json for run "${runId}" under ${path.join(outputRoot, "runs")}.` };
  }
  const cr = report.criterionResults?.find((c) => c.criterionId === criterionId);
  if (!cr) {
    const ids = (report.criterionResults ?? []).map((c) => c.criterionId).join(", ");
    return { ok: false, text: `feedback: run "${runId}" has no criterion "${criterionId}" (have: ${ids}).` };
  }
  const repo = report.request.repo;

  // What the run actually tried for this criterion — the (likely bad) probe and how it ended.
  const planned = (report.plan?.steps ?? []).filter((s) => s.criterionIds?.includes(criterionId) && s.command);
  const context = [
    `Repo: ${repo}`,
    `Criterion ${criterionId}: ${cr.criterion}`,
    `Last verdict: ${cr.result} — ${cr.reason}`,
    ...(planned.length
      ? ["Probe(s) the failed run executed (these were judged wrong or insufficient):", ...planned.map((s) => `  $ ${s.command}${s.expectSubstring ? `   # expected output to contain "${s.expectSubstring}"` : ""}`)]
      : []),
    "",
    "Operator's description of what a CORRECT check should verify (may be in any language):",
    describe,
  ].join("\n");

  const system =
    "You are VerifyFlow's probe engineer. A human says a criterion was misjudged and describes what a correct " +
    "check should verify; you turn that into one concrete, non-interactive shell command runnable from the repo " +
    "root (chain with && if it truly needs more than one step). Prefer commands quoted in the criterion or the " +
    "description over invented ones. Respond with JSON only: " +
    '{"command": "...", "expectSubstring": "...", "expectExitCode": 0, "rationale": "one sentence"}. ' +
    "Omit expectSubstring/expectExitCode when unsure rather than guessing.";

  let parsed: Partial<{ command: string; expectSubstring: string; expectExitCode: number; rationale: string }>;
  try {
    const raw = await llm.complete({ system, prompt: context.slice(0, 6000), task: "feedback-probe-suggest", tier: "smart" });
    parsed = extractJson(raw);
  } catch {
    return { ok: false, text: "feedback: the model did not return a usable probe suggestion — try again, or supply the exact command with --probe." };
  }
  const command = typeof parsed.command === "string" ? parsed.command.trim() : "";
  if (!command) {
    return { ok: false, text: "feedback: the model could not synthesize a probe (no real model available, or no command in its answer) — supply the exact command with --probe." };
  }
  const probe: Probe = { command };
  if (typeof parsed.expectSubstring === "string" && parsed.expectSubstring.trim()) probe.expectSubstring = parsed.expectSubstring.trim();
  if (typeof parsed.expectExitCode === "number" && Number.isInteger(parsed.expectExitCode)) probe.expectExitCode = parsed.expectExitCode;
  return {
    ok: true,
    repo,
    criterionText: cr.criterion,
    probe,
    rationale: typeof parsed.rationale === "string" ? parsed.rationale.trim() : "",
    text: "",
  };
}

export interface FeedbackLsResult {
  text: string;
  json: unknown;
}

export async function feedbackLs(store: MemoryStore): Promise<FeedbackLsResult> {
  const repos = await store.listFeedback();
  const json = repos.map((r) => ({ repo: r.repo, feedback: r.count }));
  if (repos.length === 0) {
    return { text: "feedback: none recorded yet (use `vf feedback <runId> --criterion <id> --false-positive`).", json };
  }
  const lines = ["Recorded false-positive feedback:", ""];
  for (const r of repos) lines.push(`- ${r.repo}: ${r.count} record(s)`);
  return { text: lines.join("\n"), json };
}

export interface FeedbackClearResult {
  cleared: string[];
  text: string;
}

export async function feedbackClear(store: MemoryStore, repo?: string): Promise<FeedbackClearResult> {
  const cleared = await store.clearFeedback(repo);
  if (cleared.length === 0) {
    return { cleared, text: repo ? `feedback: nothing stored for ${repo}.` : "feedback: nothing to clear." };
  }
  const scope = repo ? `for ${repo}` : `across ${cleared.length} repo(s)`;
  return { cleared, text: `feedback: cleared ${scope}.` };
}
