import { promises as fs } from "node:fs";
import path from "node:path";
import { run } from "../../util/exec.js";
import type { Evidence, RunReport } from "../../types.js";

const EMOJI: Record<string, string> = {
  pass: "✅",
  fail: "❌",
  partial: "🟡",
  blocked: "🚧",
  not_evaluable: "❓",
};

const EVIDENCE_ICON: Partial<Record<Evidence["type"], string>> = {
  screenshot: "🖼️",
  video: "🎬",
  browser_trace: "🔍",
  test_report: "🧪",
};

/** Render one evidence reference for the report table, with a type hint for visual artifacts. */
function renderEvidenceRef(e: Evidence): string {
  const ref = e.path ?? e.ref ?? e.type;
  const icon = EVIDENCE_ICON[e.type];
  return icon ? `${icon} \`${ref}\`` : `\`${ref}\``;
}

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
    const ev = c.evidence.map(renderEvidenceRef).join("<br>") || "—";
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

/** Hidden marker that identifies VerifyFlow's own PR comment so re-runs update it in place. */
export const VF_COMMENT_MARKER = "<!-- verifyflow:delivery-report -->";

/** Pick the id of an existing VerifyFlow comment (by marker) from a GitHub comments list. */
export function selectExistingCommentId(
  comments: Array<{ id: number; body?: string }>,
): number | undefined {
  return comments.find((c) => (c.body ?? "").includes(VF_COMMENT_MARKER))?.id;
}

/**
 * Publish the markdown report as a PR comment via the authorized `gh` CLI — idempotently.
 * If VerifyFlow already commented on this PR (identified by a hidden marker), edit that comment
 * in place instead of stacking a new one on every re-run (IN-560).
 */
export async function postPrComment(report: RunReport, body: string): Promise<boolean> {
  const repo = report.request.repo;
  const pr = report.request.prNumber;
  const marked = `${VF_COMMENT_MARKER}\n${body}`;

  const list = await run("gh", ["api", `repos/${repo}/issues/${pr}/comments?per_page=100`]);
  if (list.executed && list.code === 0) {
    try {
      const existingId = selectExistingCommentId(JSON.parse(list.stdout));
      if (existingId !== undefined) {
        const edit = await run("gh", [
          "api", "--method", "PATCH", `repos/${repo}/issues/comments/${existingId}`,
          "-f", `body=${marked}`,
        ]);
        return edit.executed && edit.code === 0;
      }
    } catch {
      /* fall through to creating a new comment */
    }
  }

  const res = await run("gh", ["pr", "comment", String(pr), "--repo", repo, "--body", marked]);
  return res.executed && res.code === 0;
}
