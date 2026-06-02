import { promises as fs } from "node:fs";
import path from "node:path";
import { run } from "../../util/exec.js";
import type { RunReport } from "../../types.js";

const EMOJI: Record<string, string> = {
  pass: "✅",
  fail: "❌",
  partial: "🟡",
  blocked: "🚧",
  not_evaluable: "❓",
};

export function renderMarkdown(report: RunReport): string {
  const r = report;
  const lines: string[] = [];
  lines.push(`# VerifyFlow delivery report — ${r.issue.key}`);
  lines.push("");
  lines.push(`> ${r.summary}`);
  lines.push("");
  lines.push("## Run");
  lines.push("");
  lines.push(`| Field | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Linear issue | [${r.issue.key}](${r.issue.url}) — ${r.issue.title} |`);
  lines.push(`| Pull request | ${r.request.repo}#${r.request.prNumber} |`);
  lines.push(`| Commit | \`${r.request.commitSha}\` |`);
  lines.push(`| Level | ${r.request.level} |`);
  lines.push(`| Policy | ${r.request.policy} |`);
  lines.push(`| Backend | ${r.request.backend} |`);
  lines.push(`| Verdict | **${r.runVerdict}** |`);
  if (r.gate) lines.push(`| Merge gate | ${r.gate.blocked ? "🔴 BLOCKED" : "🟢 pass"} — ${r.gate.reason} |`);
  lines.push("");

  lines.push("## Acceptance criteria");
  lines.push("");
  lines.push(`| # | Criterion | Result | Method | Evidence |`);
  lines.push(`| --- | --- | --- | --- | --- |`);
  for (const c of r.criterionResults) {
    const ev = c.evidence.map((e) => `\`${e.path ?? e.ref ?? e.type}\``).join("<br>") || "—";
    lines.push(
      `| ${c.criterionId} | ${escapePipes(c.criterion)} | ${EMOJI[c.result] ?? ""} ${c.result} | ${c.method} | ${ev} |`,
    );
  }
  lines.push("");

  lines.push("### Reasoning");
  for (const c of r.criterionResults) {
    lines.push(`- **${c.criterionId}** (${c.result}, confidence ${c.confidence.toFixed(2)}): ${c.reason}`);
  }
  lines.push("");

  if (r.plan.escalationRecommended) {
    lines.push(
      `> ⚠️ Escalation recommended to **${r.plan.escalationRecommended.toLevel}**: ${r.plan.escalationRecommended.reason}`,
    );
    lines.push("");
  }

  if (r.ticketQualityIssues.length) {
    lines.push("## Ticket quality notes");
    for (const q of r.ticketQualityIssues) lines.push(`- ${q}`);
    lines.push("");
  }

  lines.push("## Evaluation plan");
  for (const s of r.plan.steps) {
    const tag = s.reusedTestPoint ? " _(reused memory test point)_" : "";
    lines.push(`- \`${s.id}\`: ${s.description}${tag}${s.command ? ` → \`${s.command}\`` : ""}`);
  }
  lines.push("");
  lines.push(`_Evidence artifacts under \`${r.evidenceRoot}\`. Generated ${r.finishedAt}._`);
  return lines.join("\n") + "\n";
}

function escapePipes(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export interface WriteReportResult {
  jsonPath: string;
  markdownPath: string;
}

export async function writeReports(report: RunReport, runDir: string): Promise<WriteReportResult> {
  await fs.mkdir(runDir, { recursive: true });
  const jsonPath = path.join(runDir, "report.json");
  const markdownPath = path.join(runDir, "report.md");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2) + "\n");
  await fs.writeFile(markdownPath, renderMarkdown(report));
  return { jsonPath, markdownPath };
}

/** Publish the markdown report as a PR comment via the authorized `gh` CLI. */
export async function postPrComment(report: RunReport, body: string): Promise<boolean> {
  const res = await run("gh", [
    "pr", "comment", String(report.request.prNumber),
    "--repo", report.request.repo,
    "--body", body,
  ]);
  return res.executed && res.code === 0;
}
