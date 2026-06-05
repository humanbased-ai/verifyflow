import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "./reporter.js";
import type { CriterionResult, Evidence, RunReport } from "../../types.js";

// IN-675: visual evidence is captured on the runner's disk; the PR comment must embed/link it
// via hosted URLs. Without a URL map (local/fixture runs), rendering falls back to bare paths.

function report(criterionResults: CriterionResult[]): RunReport {
  return {
    schemaVersion: 1,
    request: {
      linearIssue: "EX-1",
      pullRequest: "https://github.com/example/app/pull/7",
      repo: "example/app",
      prNumber: 7,
      commitSha: "deadbeef",
      level: "ui",
      backend: "fallback",
      policy: "advisory",
    },
    issue: { key: "EX-1", title: "t", url: "u", source: "fixture" },
    plan: { level: "ui", steps: [], notes: [] },
    criterionResults,
    runVerdict: "needs_fix",
    summary: "ok",
    ticketQualityIssues: [],
    evidenceRoot: "runs/x/artifacts",
    environment: {},
    startedAt: "2026-06-05T00:00:00.000Z",
    finishedAt: "2026-06-05T00:00:01.000Z",
    durationMs: 1000,
  };
}

const cr = (id: string, evidence: Evidence[], result: CriterionResult["result"] = "pass"): CriterionResult => ({
  criterionId: id,
  criterion: `criterion ${id}`,
  method: "playwright_ui_flow",
  result,
  reason: "r",
  confidence: 0.9,
  evidence,
});

const shot = (path: string, summary?: string): Evidence => ({ type: "screenshot", path, summary });
const trace = (path: string): Evidence => ({ type: "browser_trace", path, summary: "session trace" });

test("renderMarkdown: hosted screenshots embed inline; the LAST one per criterion is the key", () => {
  const urls = {
    "ui/step-1.png": "https://raw.githubusercontent.com/example/app/verifyflow-evidence/7-deadbeef/ui/step-1.png",
    "ui/step-2.png": "https://raw.githubusercontent.com/example/app/verifyflow-evidence/7-deadbeef/ui/step-2.png",
  };
  const md = renderMarkdown(
    report([cr("AC-1", [shot("ui/step-1.png", "first"), shot("ui/step-2.png", "final")], "fail")]),
    { evidenceUrls: urls },
  );

  assert.match(md, /### Screenshots/);
  // Key = last screenshot for the criterion → step-2 embedded, step-1 not embedded.
  assert.match(md, /!\[final\]\(https:\/\/raw\.githubusercontent\.com\/example\/app\/verifyflow-evidence\/7-deadbeef\/ui\/step-2\.png\)/);
  assert.doesNotMatch(md, /!\[first\]/, "only the key (last) screenshot embeds");
  // The criterion result is shown next to the embedded image.
  assert.match(md, /\*\*AC-1\*\* ❌ fail/);
  // Table refs become clickable links when a URL is known.
  assert.match(md, /\[🖼️ `ui\/step-1\.png`\]\(https:\/\/raw\.githubusercontent\.com[^\)]+step-1\.png\)/);
});

test("renderMarkdown: browser_trace renders as a clickable link, not a bare path (AC-3)", () => {
  const urls = {
    "ui/trace-1.zip": "https://raw.githubusercontent.com/example/app/verifyflow-evidence/7-deadbeef/ui/trace-1.zip",
  };
  const md = renderMarkdown(report([cr("AC-1", [trace("ui/trace-1.zip")])]), { evidenceUrls: urls });
  assert.match(md, /\[🔍 `ui\/trace-1\.zip`\]\(https:\/\/raw\.githubusercontent\.com[^\)]+trace-1\.zip\)/);
  // A trace alone produces no inline image.
  assert.doesNotMatch(md, /### Screenshots/);
});

test("renderMarkdown: without a URL map, no screenshot section and refs stay bare paths (AC-4)", () => {
  const md = renderMarkdown(report([cr("AC-1", [shot("ui/step-1.png", "first"), trace("ui/trace-1.zip")])]));
  assert.doesNotMatch(md, /### Screenshots/);
  assert.doesNotMatch(md, /!\[/, "no inline images without hosted URLs");
  assert.doesNotMatch(md, /raw\.githubusercontent/, "no links without hosted URLs");
  assert.match(md, /🖼️ `ui\/step-1\.png`/, "bare path reference preserved");
});

test("renderMarkdown: a screenshot present but not hosted is not treated as key", () => {
  // Only trace is hosted; the screenshot has no URL → it must not embed.
  const urls = { "ui/trace-1.zip": "https://raw.githubusercontent.com/example/app/verifyflow-evidence/x/ui/trace-1.zip" };
  const md = renderMarkdown(report([cr("AC-1", [shot("ui/step-1.png"), trace("ui/trace-1.zip")])]), {
    evidenceUrls: urls,
  });
  assert.doesNotMatch(md, /### Screenshots/);
});
