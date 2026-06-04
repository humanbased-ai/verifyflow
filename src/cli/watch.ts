import { run } from "../util/exec.js";

/**
 * `vf watch` (IN-622): VerifyFlow as an independent delivery-gate daemon.
 *
 * Watches a repo's open PRs and, for each one whose current head carries a Crosscheck APPROVE
 * and hasn't been verified yet, runs verification and (with --auto-merge) squash-merges on a
 * clean `accept`. This is the third independent daemon in the Symphony → Crosscheck → VerifyFlow
 * pipeline (Symphony has `run`, Crosscheck has `watch`/`serve`).
 *
 * The decision core here is pure + injectable so it is unit-tested without gh or a network; the
 * live poll loop (cmdWatch in main.ts) supplies gh-backed I/O.
 */

export interface PrSummary {
  number: number;
  headSha: string;
}

/** A PR issue comment — only the body is needed to read the Crosscheck verdict. */
export interface IssueComment {
  body: string;
}

export interface WatchDeps {
  listOpenPrs: (repo: string) => Promise<PrSummary[]>;
  listIssueComments: (repo: string, pr: number) => Promise<IssueComment[]>;
  /** Verify the PR (and merge on accept when configured); returns the outcome for logging. */
  verify: (pr: PrSummary) => Promise<{ verdict: string; merged: boolean }>;
}

export interface WatchAction {
  pr: number;
  headSha: string;
  verdict: string;
  merged: boolean;
  error?: string;
}

/**
 * Decide whether a PR's latest Crosscheck review is an APPROVE.
 *
 * Handles the deployed Crosscheck 0.9.0-beta.6 format — `### Code Review by <brand>` + a
 * `✅ **APPROVE**` badge (no `[crosscheck]` marker / `VERDICT:` line) — and the older marker
 * format. The newest Crosscheck comment wins; a NEEDS WORK / REQUEST CHANGES / BLOCK there means
 * not approved.
 */
export function parseCrosscheckApprove(comments: IssueComment[]): boolean {
  // Identify Crosscheck comments specifically: its heading form `### Code Review by …` or the
  // legacy `[crosscheck]` marker. A bare "code review by" substring would also match other
  // review bots (CodeRabbit, Copilot, …), so require the heading anchor.
  const isCrosscheck = (b: string) => /^#{1,6}\s*code review by/im.test(b) || /\[crosscheck\]/i.test(b);
  const cc = comments.filter((c) => isCrosscheck(c.body));
  const last = cc[cc.length - 1];
  if (!last) return false;
  const body = last.body;
  if (/needs work|request(?:ed)?\s+changes|\bblock\b/i.test(body)) return false;
  // Only the explicit APPROVE signals — the beta.6 badge or the legacy VERDICT line. A bare
  // "approve" word is intentionally NOT accepted (it would match "cannot approve", "needs
  // approval", etc. and could trigger a wrongful auto-merge).
  return /✅\s*\*\*\s*approve\s*\*\*/i.test(body) || /verdict:\s*approve\b/i.test(body);
}

/**
 * One watch tick. For every open PR with a fresh Crosscheck APPROVE not yet verified at its
 * current head, run verification. `seen` maps prNumber → last-verified headSha so each head is
 * verified at most once. A single PR's error is recorded and never aborts the tick.
 */
export async function watchTick(
  repo: string,
  deps: WatchDeps,
  seen: Map<number, string>,
): Promise<WatchAction[]> {
  const prs = await deps.listOpenPrs(repo);
  const acted: WatchAction[] = [];
  for (const pr of prs) {
    if (seen.get(pr.number) === pr.headSha) continue; // this head already verified
    let comments: IssueComment[];
    try {
      comments = await deps.listIssueComments(repo, pr.number);
    } catch {
      continue; // transient; retry next tick (don't record the head as seen)
    }
    if (!parseCrosscheckApprove(comments)) continue;
    try {
      const r = await deps.verify(pr);
      // Dedup only AFTER a completed verification (any returned verdict). If verify throws — e.g.
      // a transient error — we do NOT stamp `seen`, so the head is retried on the next tick
      // (every `interval`, not a hot loop) rather than being skipped permanently.
      seen.set(pr.number, pr.headSha);
      acted.push({ pr: pr.number, headSha: pr.headSha, verdict: r.verdict, merged: r.merged });
    } catch (err) {
      acted.push({
        pr: pr.number,
        headSha: pr.headSha,
        verdict: "error",
        merged: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return acted;
}

// --- gh-backed I/O (live) ---------------------------------------------------------------------

/** Max open PRs polled per tick; if a repo has more, the overflow is logged (not silently dropped). */
const PR_LIST_LIMIT = 100;

/** List a repo's open PRs via the authorized `gh` CLI. */
export async function ghListOpenPrs(repo: string): Promise<PrSummary[]> {
  const res = await run("gh", ["pr", "list", "--repo", repo, "--state", "open", "--json", "number,headRefOid", "--limit", String(PR_LIST_LIMIT)]);
  if (!res.executed || res.code !== 0) throw new Error(res.spawnError ?? `gh pr list failed: ${res.stderr.slice(0, 200)}`);
  const raw = JSON.parse(res.stdout || "[]") as { number: number; headRefOid: string }[];
  if (raw.length >= PR_LIST_LIMIT) {
    console.error(`[verifyflow] vf watch: ${repo} has >= ${PR_LIST_LIMIT} open PRs; only the first ${PR_LIST_LIMIT} are polled this tick.`);
  }
  return raw.map((p) => ({ number: p.number, headSha: p.headRefOid }));
}

/** List a PR's issue-thread comments via `gh api`. */
export async function ghListIssueComments(repo: string, pr: number): Promise<IssueComment[]> {
  const res = await run("gh", ["api", `repos/${repo}/issues/${pr}/comments`, "--paginate"]);
  if (!res.executed || res.code !== 0) throw new Error(res.spawnError ?? `gh api comments failed: ${res.stderr.slice(0, 200)}`);
  const raw = JSON.parse(res.stdout || "[]") as { body?: string }[];
  return raw.map((c) => ({ body: c.body ?? "" }));
}

/** Squash-merge a PR via `gh`, pinned to the head sha so a raced push can't be merged blindly. */
export async function ghMergePr(repo: string, pr: number, headSha: string): Promise<boolean> {
  const res = await run("gh", ["pr", "merge", String(pr), "--repo", repo, "--squash", "--match-head-commit", headSha]);
  return res.executed && res.code === 0;
}
