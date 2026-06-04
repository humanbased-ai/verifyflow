import { promises as fs } from "node:fs";
import path from "node:path";
import type { ImprovementSignal, RunReport } from "../types.js";

/**
 * `vf show <runId>` and `vf signal <runId>` (IN-625): re-render a past run's stored report and
 * improvement signal from `<outputRoot>/runs/<runId>/`. Pure read/format logic, separated from
 * the CLI wrapper for testability. Nothing here re-executes anything — it reads what a prior run
 * already wrote to disk.
 */

export function runDirFor(outputRoot: string, runId: string): string {
  return path.join(outputRoot, "runs", runId);
}

async function readFileOrUndefined(p: string): Promise<string | undefined> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return undefined;
  }
}

export interface ShowResult {
  found: boolean;
  text: string;
}

/** Render a stored run's report.md, or report.json when `json` is true. */
export async function showRun(outputRoot: string, runId: string, json = false): Promise<ShowResult> {
  const dir = runDirFor(outputRoot, runId);
  const file = path.join(dir, json ? "report.json" : "report.md");
  const content = await readFileOrUndefined(file);
  if (content === undefined) {
    return {
      found: false,
      text: `show: no ${json ? "report.json" : "report.md"} for run "${runId}" under ${path.join(outputRoot, "runs")}.`,
    };
  }
  return { found: true, text: content.trimEnd() };
}

const SEVERITY_ICON: Record<string, string> = {
  must_fix: "🔴",
  investigate: "🟠",
  needs_clarification: "🟡",
};

/** Pretty-print an improvement signal for human bounce-back debugging. */
export function renderSignal(signal: ImprovementSignal): string {
  const lines = [
    `Improvement signal — ${signal.linearIssue} (${signal.repo}#${signal.prNumber})`,
    `Verdict: ${signal.verdict} · ${signal.items.length} actionable item(s) · commit ${signal.commitSha || "(unknown)"}`,
    "",
  ];
  for (const it of signal.items) {
    const icon = SEVERITY_ICON[it.severity] ?? "•";
    lines.push(`${icon} ${it.criterionId} [${it.severity}] (${it.result}) — ${it.criterion}`);
    if (it.failureCategory) lines.push(`    category: ${it.failureCategory}`);
    lines.push(`    expected: ${it.expected}`);
    lines.push(`    observed: ${it.observed}`);
    if (it.probeCommand) lines.push(`    probe:    ${it.probeCommand}`);
    if (it.evidence.length) lines.push(`    evidence: ${it.evidence.join(", ")}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export interface SignalResult {
  found: boolean;
  text: string;
}

/** Read and pretty-print `<runId>/improvement-signal.json`, or its raw JSON when `json` is true. */
export async function showSignal(outputRoot: string, runId: string, json = false): Promise<SignalResult> {
  const dir = runDirFor(outputRoot, runId);
  const raw = await readFileOrUndefined(path.join(dir, "improvement-signal.json"));
  if (raw === undefined) {
    return {
      found: false,
      text:
        `signal: no improvement-signal.json for run "${runId}" — either the run does not exist, ` +
        `or every criterion passed (a clean run emits no bounce-back signal).`,
    };
  }
  if (json) return { found: true, text: raw.trimEnd() };
  try {
    const signal = JSON.parse(raw) as ImprovementSignal;
    return { found: true, text: renderSignal(signal) };
  } catch {
    return { found: false, text: `signal: improvement-signal.json for run "${runId}" is not valid JSON.` };
  }
}
