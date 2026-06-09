import { promises as fs } from "node:fs";
import path from "node:path";
import type { MemoryStore, IssueRecord } from "../memory/store.js";
import type { LlmClient } from "../backends/llm.js";
import type { RunReport } from "../types.js";
import { extractJson } from "../util/json.js";
import { runDirFor, isUnsafeRunId } from "./inspect.js";

/**
 * `vf issue` (IN-807): capture a bug/error, have the LLM produce a structured analysis, and
 * persist it to the memory store as a per-repo knowledge log. Pure logic, separated from the CLI
 * wrapper so it is unit-testable with a stub LLM and a real on-disk MemoryStore.
 */

export interface IssueAnalysis {
  title: string;
  category: string;
  rootCause: string;
  impact: string;
  reproduction: string;
  suggestedFix: string;
}

function firstLine(s: string): string {
  const t = (s.split("\n").find((l) => l.trim()) ?? "reported issue").trim();
  return t.length > 80 ? t.slice(0, 77) + "…" : t;
}

/**
 * Analyze a bug/error report into structured fields. Injectable LLM so it is testable. Falls back
 * to a minimal record (title from the input) when no model is available or the output is unparsable
 * — capturing the issue must never hard-fail for lack of an LLM.
 */
export async function analyzeIssue(llm: LlmClient, input: string): Promise<IssueAnalysis> {
  const fallback: IssueAnalysis = { title: firstLine(input), category: "unknown", rootCause: "", impact: "", reproduction: "", suggestedFix: "" };
  if (!(await llm.available())) return fallback;
  const system =
    "You are VerifyFlow's incident analyst. Given a bug/error report, produce a concise structured " +
    "analysis. Respond with JSON only and keep each field to one or two short sentences: " +
    '{"title": "...", "category": "...", "rootCause": "...", "impact": "...", "reproduction": "...", "suggestedFix": "..."}.';
  try {
    const raw = await llm.complete({ system, prompt: input.slice(0, 6000), task: "issue-analysis", tier: "smart" });
    const p = extractJson<Partial<IssueAnalysis>>(raw);
    return {
      title: (p.title || "").trim() || fallback.title,
      category: (p.category || "").trim() || "unknown",
      rootCause: (p.rootCause || "").trim(),
      impact: (p.impact || "").trim(),
      reproduction: (p.reproduction || "").trim(),
      suggestedFix: (p.suggestedFix || "").trim(),
    };
  } catch {
    return fallback;
  }
}

export interface FromRunResult {
  ok: boolean;
  text?: string;
  repo?: string;
  input?: string;
}

/**
 * Build an error-context blob from a past run's stored report: repo/issue/verdict header + every
 * non-pass criterion's id/result/reason. Reads only what a prior `vf run` already wrote.
 */
export async function issueContextFromRun(outputRoot: string, runId: string): Promise<FromRunResult> {
  if (isUnsafeRunId(runId)) {
    return { ok: false, text: `issue: "${runId}" is not a valid run id (must be a single run directory name).` };
  }
  let report: RunReport;
  try {
    report = JSON.parse(await fs.readFile(path.join(runDirFor(outputRoot, runId), "report.json"), "utf8")) as RunReport;
  } catch {
    return { ok: false, text: `issue: no readable report.json for run "${runId}" under ${path.join(outputRoot, "runs")}.` };
  }
  // Guard against a malformed / older-schema report so a missing field is a clean error, not a crash.
  if (!report || !Array.isArray(report.criterionResults) || !report.request?.repo) {
    return { ok: false, text: `issue: run "${runId}" report.json is missing expected fields (criterionResults / request.repo).` };
  }
  const nonPass = report.criterionResults.filter((c) => c.result !== "pass");
  const lines = [
    `Run ${runId} · ${report.request.repo} PR #${report.request.prNumber ?? "-"} · issue ${report.issue?.key ?? "-"}`,
    `Run verdict: ${report.runVerdict ?? "-"}`,
    "",
    "Non-passing criteria:",
    ...(nonPass.length
      ? nonPass.map((c) => `- ${c.criterionId} [${c.result}] ${c.criterion} — ${c.reason}`)
      : ["(none — all criteria passed)"]),
  ];
  return { ok: true, repo: report.request.repo, input: lines.join("\n") };
}

export function renderIssue(r: IssueRecord): string {
  const lines = [
    `Issue ${r.id}  ·  ${r.title}`,
    "",
    `  repo:        ${r.repo}`,
    `  category:    ${r.category ?? "unknown"}`,
    `  source:      ${r.source}`,
  ];
  if (r.rootCause) lines.push(`  root cause:  ${r.rootCause}`);
  if (r.impact) lines.push(`  impact:      ${r.impact}`);
  if (r.reproduction) lines.push(`  reproduce:   ${r.reproduction}`);
  if (r.suggestedFix) lines.push(`  suggest fix: ${r.suggestedFix}`);
  if (r.note) lines.push(`  note:        ${r.note}`);
  lines.push(`  created:     ${r.createdAt}`);
  return lines.join("\n");
}

export interface CaptureResult {
  ok: boolean;
  text: string;
  record?: IssueRecord;
}

/** Analyze `input` and persist an issue record for `repo`. */
export async function captureIssue(
  store: MemoryStore,
  llm: LlmClient,
  opts: { repo: string; input: string; source: string; note?: string; now: string },
): Promise<CaptureResult> {
  const a = await analyzeIssue(llm, opts.note ? `${opts.input}\n\nNote: ${opts.note}` : opts.input);
  const record = await store.recordIssue(opts.repo, {
    title: a.title, category: a.category, rootCause: a.rootCause, impact: a.impact,
    reproduction: a.reproduction, suggestedFix: a.suggestedFix,
    source: opts.source, input: opts.input.slice(0, 2000), note: opts.note, createdAt: opts.now,
  });
  return { ok: true, record, text: `${renderIssue(record)}\n\nissue: captured + saved to memory for ${opts.repo} (id ${record.id}).` };
}

export interface IssueLsResult { text: string; json: unknown; }

export async function issueLs(store: MemoryStore): Promise<IssueLsResult> {
  const repos = await store.listIssues();
  const json = repos.map((r) => ({ repo: r.repo, issues: r.count }));
  if (repos.length === 0) return { text: "issue: none captured yet (use `vf issue \"<description>\"` or `--from-run <runId>`).", json };
  const lines = ["Captured issues:", ""];
  for (const r of repos) lines.push(`- ${r.repo}: ${r.count} issue(s)`);
  return { text: lines.join("\n"), json };
}
