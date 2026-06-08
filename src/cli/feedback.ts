import { promises as fs } from "node:fs";
import path from "node:path";
import type { MemoryStore, FeedbackRecord } from "../memory/store.js";
import type { RunReport } from "../types.js";
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
