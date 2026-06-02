import { promises as fs } from "node:fs";
import path from "node:path";
import { run } from "../../util/exec.js";
import type { ChangedFile, PrContext } from "../../types.js";

export interface PrRef {
  repo: string; // owner/repo
  number: number;
}

/** Parse a PR URL or "owner/repo#123" into a {repo, number}. */
export function parsePrRef(input: string, fallbackRepo?: string): PrRef {
  const url = input.match(
    /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i,
  );
  if (url) return { repo: url[1]!, number: Number(url[2]) };

  const short = input.match(/^([^/]+\/[^/#]+)#(\d+)$/);
  if (short) return { repo: short[1]!, number: Number(short[2]) };

  const bare = input.match(/^#?(\d+)$/);
  if (bare && fallbackRepo) return { repo: fallbackRepo, number: Number(bare[1]) };

  throw new Error(
    `cannot parse PR reference "${input}" (expected URL, owner/repo#123, or #123 with --repo)`,
  );
}

export interface GithubClient {
  loadPr(ref: PrRef): Promise<PrContext>;
}

/** Live GitHub access through the authorized `gh` CLI. */
export class GhCliClient implements GithubClient {
  private readonly maxDiffBytes: number;
  constructor(opts: { maxDiffBytes?: number } = {}) {
    this.maxDiffBytes = opts.maxDiffBytes ?? 200_000;
  }

  async loadPr(ref: PrRef): Promise<PrContext> {
    const fields =
      "number,title,body,headRefName,headRefOid,baseRefName,additions,deletions,files,url";
    const meta = await run("gh", [
      "pr", "view", String(ref.number),
      "--repo", ref.repo,
      "--json", fields,
    ]);
    if (!meta.executed) throw new Error(`gh not available: ${meta.spawnError}`);
    if (meta.code !== 0) throw new Error(`gh pr view failed: ${meta.stderr.slice(0, 400)}`);

    const j = JSON.parse(meta.stdout) as {
      number: number; title: string; body: string;
      headRefName: string; headRefOid: string; baseRefName: string;
      additions: number; deletions: number; url: string;
      files: { path: string; additions: number; deletions: number }[];
    };

    const diffRes = await run("gh", ["pr", "diff", String(ref.number), "--repo", ref.repo]);
    let diff = diffRes.code === 0 ? diffRes.stdout : "";
    let truncated = false;
    if (diff.length > this.maxDiffBytes) {
      diff = diff.slice(0, this.maxDiffBytes);
      truncated = true;
    }

    return {
      repo: ref.repo,
      number: j.number,
      url: j.url,
      title: j.title,
      body: j.body ?? "",
      headRef: j.headRefName,
      headSha: j.headRefOid,
      baseRef: j.baseRefName,
      additions: j.additions,
      deletions: j.deletions,
      changedFiles: (j.files ?? []).map(
        (f): ChangedFile => ({ path: f.path, additions: f.additions, deletions: f.deletions }),
      ),
      diff: truncated ? diff + "\n... [diff truncated by VerifyFlow] ..." : diff,
      source: "gh-cli",
    };
  }
}

/** Reads a recorded PR fixture: <dir>/pr.json (+ optional pr.diff). */
export class FixtureGithubClient implements GithubClient {
  constructor(private readonly dir: string) {}
  async loadPr(_ref: PrRef): Promise<PrContext> {
    const raw = await fs.readFile(path.join(this.dir, "pr.json"), "utf8");
    const ctx = JSON.parse(raw) as PrContext;
    if (!ctx.diff) {
      try {
        ctx.diff = await fs.readFile(path.join(this.dir, "pr.diff"), "utf8");
      } catch {
        ctx.diff = "";
      }
    }
    ctx.source = "fixture";
    return ctx;
  }
}
