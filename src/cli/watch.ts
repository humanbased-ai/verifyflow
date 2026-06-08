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
  /** PR title, for human-readable progress output (IN-749). Optional: not all callers supply it. */
  title?: string;
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
 * Optional observability hooks (IN-749). Pure logging — they never influence the decision logic,
 * so omitting them (as the unit tests do) leaves behavior identical. The live daemon supplies them
 * to stream a per-tick heartbeat and per-PR framing.
 */
export interface WatchObserver {
  /** Fired once per tick, after triage, with the PR counts seen this poll. */
  tick?: (summary: { open: number; alreadyVerified: number; toVerify: number }) => void;
  /** Fired just before a PR is verified, so its identity (number + title) can be announced. */
  verifyStart?: (pr: PrSummary) => void;
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
  observer?: WatchObserver,
): Promise<WatchAction[]> {
  const prs = await deps.listOpenPrs(repo);
  // Prune dedup entries for PRs that are no longer open (merged/closed) so `seen` can't grow
  // unbounded on a long-running daemon.
  const open = new Set(prs.map((p) => p.number));
  for (const n of [...seen.keys()]) if (!open.has(n)) seen.delete(n);

  // Triage pass: decide which PRs are eligible to verify this tick (approved + a fresh head),
  // counting the rest, so the observer can emit one heartbeat before any (slow) verification runs.
  let alreadyVerified = 0;
  const toVerify: PrSummary[] = [];
  for (const pr of prs) {
    if (seen.get(pr.number) === pr.headSha) {
      alreadyVerified++;
      continue; // this head already verified
    }
    let comments: IssueComment[];
    try {
      comments = await deps.listIssueComments(repo, pr.number);
    } catch {
      continue; // transient; retry next tick (don't record the head as seen)
    }
    if (!parseCrosscheckApprove(comments)) continue;
    toVerify.push(pr);
  }
  observer?.tick?.({ open: prs.length, alreadyVerified, toVerify: toVerify.length });

  const acted: WatchAction[] = [];
  for (const pr of toVerify) {
    observer?.verifyStart?.(pr);
    try {
      const r = await deps.verify(pr);
      // Dedup only after a CONCLUSIVE verification. A non-conclusive `"error"` verdict — verify
      // couldn't run (it threw and was caught below, OR the run executor returned an error code
      // without throwing) — is NOT stamped, so the head is retried next tick (every `interval`,
      // not a hot loop) instead of being permanently skipped. Real verdicts (accept / needs_fix /
      // manual_review_required / …) are stamped so the same head isn't re-verified.
      if (r.verdict !== "error") seen.set(pr.number, pr.headSha);
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

/** Max open PRs polled per tick; if a repo has more, the overflow is logged and skipped this tick. */
const PR_LIST_LIMIT = 100;

/** List a repo's open PRs via the authorized `gh` CLI. */
export async function ghListOpenPrs(repo: string): Promise<PrSummary[]> {
  const res = await run("gh", ["pr", "list", "--repo", repo, "--state", "open", "--json", "number,headRefOid,title", "--limit", String(PR_LIST_LIMIT)]);
  if (!res.executed || res.code !== 0) throw new Error(res.spawnError ?? `gh pr list failed: ${res.stderr.slice(0, 200)}`);
  const raw = JSON.parse(res.stdout || "[]") as { number: number; headRefOid: string; title?: string }[];
  if (raw.length >= PR_LIST_LIMIT) {
    console.error(`[verifyflow] vf watch: ${repo} has >= ${PR_LIST_LIMIT} open PRs; only the first ${PR_LIST_LIMIT} are polled this tick.`);
  }
  return raw.map((p) => ({ number: p.number, headSha: p.headRefOid, title: p.title }));
}

/**
 * List a PR's issue-thread comments via `gh api`. Uses `--jq '.[]'` so paginated results come
 * back as one JSON object per line (NDJSON) — plain `--paginate` concatenates a separate JSON
 * array per page, which `JSON.parse` cannot read once a PR has 30+ comments.
 */
export async function ghListIssueComments(repo: string, pr: number): Promise<IssueComment[]> {
  const res = await run("gh", ["api", `repos/${repo}/issues/${pr}/comments`, "--paginate", "--jq", ".[]"]);
  if (!res.executed || res.code !== 0) throw new Error(res.spawnError ?? `gh api comments failed: ${res.stderr.slice(0, 200)}`);
  return res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        const o = JSON.parse(line) as { body?: string };
        return { body: o.body ?? "" };
      } catch {
        return { body: "" };
      }
    });
}

/** Squash-merge a PR via `gh`, pinned to the head sha so a raced push can't be merged blindly. */
export async function ghMergePr(repo: string, pr: number, headSha: string): Promise<boolean> {
  const res = await run("gh", ["pr", "merge", String(pr), "--repo", repo, "--squash", "--match-head-commit", headSha]);
  return res.executed && res.code === 0;
}
