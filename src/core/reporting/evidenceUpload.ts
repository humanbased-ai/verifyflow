import { promises as fs } from "node:fs";
import path from "node:path";
import { run } from "../../util/exec.js";
import type { Evidence, RunReport } from "../../types.js";

/**
 * IN-675: visual evidence (screenshots, the Playwright trace, video) is captured under the
 * runner's artifact root, which a PR reviewer cannot reach — so the delivery-report comment
 * showed only filenames. We host those artifacts on a dedicated branch in the target repo and
 * hand the reporter a `path -> raw URL` map so the comment can embed/link them.
 *
 * The branch carries main's history plus a per-run directory; re-running the same PR+commit
 * overwrites the same paths (one commit per run), so it never stacks (AC-5).
 */
export const EVIDENCE_BRANCH = "verifyflow-evidence";

/** Evidence types worth hosting so a reviewer can actually open them. */
const HOSTED_TYPES = new Set<Evidence["type"]>(["screenshot", "video", "browser_trace"]);

/** Call `gh api` with an optional JSON body on stdin; returns parsed JSON when the call succeeds. */
async function ghApi(
  args: string[],
  body?: unknown,
): Promise<{ ok: boolean; json?: any; code: number | null }> {
  const full = body === undefined ? args : [...args, "--input", "-"];
  const res = await run("gh", ["api", ...full], {
    input: body === undefined ? undefined : JSON.stringify(body),
  });
  const ok = res.executed && res.code === 0;
  if (!ok) return { ok, code: res.code };
  try {
    return { ok, code: res.code, json: res.stdout.trim() ? JSON.parse(res.stdout) : {} };
  } catch {
    return { ok: false, code: res.code };
  }
}

/** Build the public raw URL for a path on the evidence branch (segments encoded, slashes kept). */
function rawUrl(repo: string, remotePath: string): string {
  const encoded = remotePath.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${repo}/${EVIDENCE_BRANCH}/${encoded}`;
}

/** Ensure the evidence branch exists; create it from the default branch head when missing. */
async function ensureBranch(repo: string): Promise<boolean> {
  const existing = await ghApi([`repos/${repo}/git/ref/heads/${EVIDENCE_BRANCH}`]);
  if (existing.ok) return true;

  const meta = await ghApi([`repos/${repo}`]);
  const defaultBranch = meta.json?.default_branch;
  if (!meta.ok || !defaultBranch) return false;

  const head = await ghApi([`repos/${repo}/git/ref/heads/${defaultBranch}`]);
  const sha = head.json?.object?.sha;
  if (!head.ok || !sha) return false;

  const created = await ghApi([`repos/${repo}/git/refs`], {
    ref: `refs/heads/${EVIDENCE_BRANCH}`,
    sha,
  });
  return created.ok;
}

/**
 * Push every hosted visual artifact referenced by the report to the evidence branch in a single
 * commit, and return a `evidence.path -> raw URL` map. Best-effort: on any failure (no gh, no
 * push rights, missing file) it returns whatever it resolved — the reporter falls back to bare
 * paths for the rest, so a hosting hiccup never blocks the PR comment.
 */
export async function publishEvidenceArtifacts(
  report: RunReport,
  runDir: string,
): Promise<Record<string, string>> {
  const repo = report.request.repo;
  const sha = (report.request.commitSha ?? "nocommit").slice(0, 12);
  const prefix = `${report.request.prNumber}-${sha}`;
  const artifactRoot = path.join(runDir, "artifacts");

  // Unique artifact paths we want hosted (dedup; many criteria can share a screenshot/trace).
  const paths = new Set<string>();
  for (const c of report.criterionResults) {
    for (const e of c.evidence) {
      if (e.path && HOSTED_TYPES.has(e.type)) paths.add(e.path);
    }
  }
  if (paths.size === 0) return {};

  if (!(await ensureBranch(repo))) return {};

  // Read + base64 each file into a blob; skip any that can't be read (best-effort).
  const blobs: Array<{ relPath: string; remotePath: string; blobSha: string }> = [];
  for (const relPath of paths) {
    let content: Buffer;
    try {
      content = await fs.readFile(path.join(artifactRoot, relPath));
    } catch {
      continue;
    }
    const blob = await ghApi([`repos/${repo}/git/blobs`], {
      content: content.toString("base64"),
      encoding: "base64",
    });
    const blobSha = blob.json?.sha;
    if (!blob.ok || !blobSha) continue;
    blobs.push({ relPath, remotePath: `${prefix}/${relPath}`, blobSha });
  }
  if (blobs.length === 0) return {};

  // One commit on top of the branch head carrying all blobs at their per-run paths.
  const head = await ghApi([`repos/${repo}/git/ref/heads/${EVIDENCE_BRANCH}`]);
  const headSha = head.json?.object?.sha;
  if (!head.ok || !headSha) return {};
  const headCommit = await ghApi([`repos/${repo}/git/commits/${headSha}`]);
  const baseTree = headCommit.json?.tree?.sha;
  if (!headCommit.ok || !baseTree) return {};

  const tree = await ghApi([`repos/${repo}/git/trees`], {
    base_tree: baseTree,
    tree: blobs.map((b) => ({ path: b.remotePath, mode: "100644", type: "blob", sha: b.blobSha })),
  });
  const treeSha = tree.json?.sha;
  if (!tree.ok || !treeSha) return {};

  const commit = await ghApi([`repos/${repo}/git/commits`], {
    message: `verifyflow: evidence for ${repo}#${report.request.prNumber} @ ${sha}`,
    tree: treeSha,
    parents: [headSha],
  });
  const commitSha = commit.json?.sha;
  if (!commit.ok || !commitSha) return {};

  const updated = await ghApi(["--method", "PATCH", `repos/${repo}/git/refs/heads/${EVIDENCE_BRANCH}`], {
    sha: commitSha,
    force: true,
  });
  if (!updated.ok) return {};

  const urls: Record<string, string> = {};
  for (const b of blobs) urls[b.relPath] = rawUrl(repo, b.remotePath);
  return urls;
}
