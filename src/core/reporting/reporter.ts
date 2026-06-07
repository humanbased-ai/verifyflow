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

export interface RenderOptions {
  /**
   * IN-675: map from `evidence.path` to a public URL where the artifact is hosted (see
   * evidenceUpload.ts). When present, visual-evidence references become clickable links and
   * the report gains an inline screenshot section. Absent for local/fixture runs, which keep
   * rendering bare on-disk paths.
   */
  evidenceUrls?: Record<string, string>;
}

/** Render one evidence reference for the report table, with a type hint for visual artifacts. */
function renderEvidenceRef(e: Evidence, urls?: Record<string, string>): string {
  const ref = e.path ?? e.ref ?? e.type;
  const icon = EVIDENCE_ICON[e.type];
  const label = icon ? `${icon} \`${ref}\`` : `\`${ref}\``;
  const url = e.path ? urls?.[e.path] : undefined;
  return url ? `[${label}](${url})` : label;
}

/** The key screenshot for a criterion is its last one — the final/most-relevant observed state. */
function keyScreenshot(evidence: Evidence[], urls: Record<string, string>): Evidence | undefined {
  let last: Evidence | undefined;
  for (const e of evidence) {
    if (e.type === "screenshot" && e.path && urls[e.path]) last = e;
  }
  return last;
}

export function renderMarkdown(report: RunReport, opts: RenderOptions = {}): string {
  const urls = opts.evidenceUrls ?? {};
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
    const ev = c.evidence.map((e) => renderEvidenceRef(e, urls)).join("<br>") || "—";
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

  // Inline screenshots (IN-675): artifacts live on the runner's disk, unreachable by a reviewer.
  // When hosted (urls present), embed the key screenshot per criterion so the comment shows the
  // actual observed state, not just a filename. Bounded to one image per criterion to stay readable.
  const shots: Array<{ c: (typeof r.criterionResults)[number]; e: Evidence }> = [];
  for (const c of r.criterionResults) {
    const e = keyScreenshot(c.evidence, urls);
    if (e) shots.push({ c, e });
  }
  if (shots.length) {
    lines.push("### Screenshots");
    lines.push("");
    for (const { c, e } of shots) {
      lines.push(`**${c.criterionId}** ${EMOJI[c.result] ?? ""} ${c.result} — ${escapePipes(c.criterion)}`);
      lines.push("");
      lines.push(`![${e.summary ?? c.criterionId}](${urls[e.path!]})`);
      lines.push("");
    }
  }

  // Evidence excerpts (IN-579): artifacts live on the runner's disk, which a PR reviewer
  // cannot reach — inline the captured output in collapsed blocks, deduped by artifact path.
  const excerpted = new Map<string, { evidence: Evidence; criterionIds: string[] }>();
  for (const c of r.criterionResults) {
    for (const e of c.evidence) {
      if (!e.excerpt || !e.path) continue;
      const entry = excerpted.get(e.path);
      if (entry) {
        if (!entry.criterionIds.includes(c.criterionId)) entry.criterionIds.push(c.criterionId);
      } else {
        excerpted.set(e.path, { evidence: e, criterionIds: [c.criterionId] });
      }
    }
  }
  if (excerpted.size) {
    lines.push("### Evidence excerpts");
    lines.push("");
    for (const [p, { evidence, criterionIds }] of excerpted) {
      lines.push(`<details><summary><code>${p}</code> — ${criterionIds.join(", ")}</summary>`);
      lines.push("");
      lines.push("```text");
      // A stray ``` in the output would break out of the fence — soften it.
      lines.push(evidence.excerpt!.replace(/```/g, "`​``").trimEnd());
      lines.push("```");
      lines.push("");
      lines.push("</details>");
    }
    lines.push("");
  }

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
export async function postPrComment(report: RunReport, body: string): Promise<string | undefined> {
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
        if (edit.executed && edit.code === 0) {
          try {
            const parsed = JSON.parse(edit.stdout) as { html_url?: string };
            return parsed.html_url ?? undefined;
          } catch {
            return undefined;
          }
        }
        return undefined;
      }
    } catch {
      /* fall through to creating a new comment */
    }
  }

  const res = await run("gh", ["pr", "comment", String(pr), "--repo", repo, "--body", marked]);
  if (res.executed && res.code === 0) {
    const url = res.stdout.trim();
    return url.startsWith("https://") ? url : undefined;
  }
  return undefined;
}
