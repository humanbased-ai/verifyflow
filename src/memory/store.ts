import { promises as fs } from "node:fs";
import path from "node:path";
import type { CriterionResultValue, FailureCategory, Probe, TestPoint } from "../types.js";

// Slug a repo string into a single safe path segment. Dots are kept on purpose — GitHub
// owner/repo names legitimately contain them (e.g. `my.org/some.repo`). Path separators are not
// in the allowlist, so any `/` (or other traversal punctuation) collapses to `_`, which keeps the
// result a single directory name and neutralizes `../`-style traversal from a `--repo` argument.
const slug = (repo: string) => repo.replace(/[^a-zA-Z0-9._-]+/g, "_");
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Minimum token-set similarity for a fuzzy memory reuse (IN-553). Tuned to reuse rewordings
 * of the same criterion while rejecting genuinely different ones. */
export const MEMORY_MATCH_THRESHOLD = 0.6;

const MATCH_STOPWORDS = new Set([
  "the", "and", "for", "are", "not", "with", "that", "this", "when", "then", "should",
  "must", "via", "from", "into", "its", "a", "an", "is", "it", "of", "to", "in", "on",
]);

/** Crude singular stem so "prints"/"print" and "exits"/"exit" compare equal. */
function stem(t: string): string {
  return t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t;
}

/** Significant lowercase tokens (length > 2, minus stopwords, lightly stemmed). */
function tokens(s: string): Set<string> {
  return new Set(
    norm(s)
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !MATCH_STOPWORDS.has(t))
      .map(stem),
  );
}

/** Jaccard similarity of two token sets: |A∩B| / |A∪B|, in [0,1]. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface TestPointMatch {
  point: TestPoint;
  /** 1 for an exact normalized-text match; otherwise the fuzzy similarity score. */
  score: number;
  exact: boolean;
}

export interface FailureModeRecord {
  category: FailureCategory;
  component: string;
  count: number;
  lastSeen: string;
}

/**
 * A human correction recorded via `vf feedback` (IN-792): "this criterion was misjudged". On a
 * later run, a criterion whose text matches a stored record is downgraded from fail/partial to
 * `blocked` so the false positive is not re-flagged. Keyed by criterion text (same fuzzy match as
 * test points), so a reworded-but-equivalent criterion is still recognized.
 */
export interface FeedbackRecord {
  kind: "false_positive";
  criterionText: string;
  /** The owner/repo this applies to. Set by `recordFeedback`; lets `listFeedback` show the real
   * name even when no sibling test point exists to recover it from the slug. */
  repo?: string;
  note?: string;
  /** The run the correction came from, for auditability. */
  runId?: string;
  createdAt: string;
}

/**
 * Pure matcher (no disk) shared by the store and the verdict engine: exact normalized-text match
 * wins, otherwise the highest token-set similarity above MEMORY_MATCH_THRESHOLD — identical logic
 * to `matchTestPoint`, so feedback and probe reuse agree on what "the same criterion" means.
 */
export function matchFeedbackRecords(
  records: FeedbackRecord[],
  criterionText: string,
): FeedbackRecord | undefined {
  if (records.length === 0) return undefined;
  const target = norm(criterionText);
  const exact = records.find((r) => norm(r.criterionText) === target);
  if (exact) return exact;
  const tt = tokens(criterionText);
  let best: FeedbackRecord | undefined;
  let bestScore = 0;
  for (const r of records) {
    const s = jaccard(tt, tokens(r.criterionText));
    if (s > bestScore) {
      bestScore = s;
      best = r;
    }
  }
  return best && bestScore >= MEMORY_MATCH_THRESHOLD ? best : undefined;
}

/**
 * Whether a probe's outcome is worth caching as a reusable test point (IN-792). A `blocked` result
 * means the check could not run as intended (environment/harness failure, timeout) — caching that
 * probe would replay the same broken command and re-manufacture the false signal next run, so it is
 * excluded. pass/fail/partial/not_evaluable all reflect a probe that actually executed.
 */
export function isReusableProbeResult(result: CriterionResultValue): boolean {
  return result !== "blocked";
}

/**
 * File-based memory. This is the difference between VerifyFlow and a stateless judge
 * (Karpathy: keep reusable memory, not just a score). Test points captured on one run are
 * reused on the next; failure modes accumulate to reveal systemic problems.
 *
 * Layout: <root>/memory/<repo-slug>/testpoints.json , failuremodes.json
 */
export class MemoryStore {
  constructor(private readonly root: string) {}

  private dir(repo: string) {
    return path.join(this.root, "memory", slug(repo));
  }

  async loadTestPoints(repo: string): Promise<TestPoint[]> {
    try {
      const raw = await fs.readFile(path.join(this.dir(repo), "testpoints.json"), "utf8");
      return JSON.parse(raw) as TestPoint[];
    } catch {
      return [];
    }
  }

  /**
   * Find a previously-stored probe for an equivalent criterion (the "feed-back" mechanism).
   *
   * Exact normalized-text match wins; otherwise the highest token-set similarity above
   * MEMORY_MATCH_THRESHOLD is reused (IN-553) — so a reworded-but-equivalent criterion still
   * reuses its probe instead of re-deriving from scratch, while a genuinely different criterion
   * does not false-match. When `component` is given, same-component points are preferred.
   */
  async matchTestPoint(repo: string, criterionText: string, component?: string): Promise<TestPoint | undefined> {
    return (await this.matchTestPointDetailed(repo, criterionText, component))?.point;
  }

  /** Like matchTestPoint, but also returns the match score (for reuse-rate logging). */
  async matchTestPointDetailed(
    repo: string,
    criterionText: string,
    component?: string,
  ): Promise<TestPointMatch | undefined> {
    const points = await this.loadTestPoints(repo);
    if (points.length === 0) return undefined;

    const target = norm(criterionText);
    const exact = points.find((p) => norm(p.criterionText) === target);
    if (exact) return { point: exact, score: 1, exact: true };

    const tt = tokens(criterionText);
    let best: TestPoint | undefined;
    let bestScore = 0;
    for (const p of points) {
      let s = jaccard(tt, tokens(p.criterionText));
      if (component && p.component === component) s += 0.05; // gentle same-component preference
      if (s > bestScore) {
        bestScore = s;
        best = p;
      }
    }
    return best && bestScore >= MEMORY_MATCH_THRESHOLD ? { point: best, score: bestScore, exact: false } : undefined;
  }

  async upsertTestPoint(input: {
    repo: string;
    component: string;
    criterionText: string;
    method: TestPoint["method"];
    probe: Probe;
    result?: CriterionResultValue;
    now: string;
  }): Promise<void> {
    const dir = this.dir(input.repo);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "testpoints.json");
    const points = await this.loadTestPoints(input.repo);
    const id = norm(input.criterionText);
    const existing = points.find((p) => norm(p.criterionText) === id);
    if (existing) {
      existing.probe = input.probe;
      existing.method = input.method;
      existing.lastResult = input.result;
      existing.runs += 1;
      existing.updatedAt = input.now;
    } else {
      points.push({
        id: slug(input.repo) + ":" + Buffer.from(id).toString("base64url").slice(0, 16),
        repo: input.repo,
        component: input.component,
        criterionText: input.criterionText,
        method: input.method,
        probe: input.probe,
        lastResult: input.result,
        runs: 1,
        createdAt: input.now,
        updatedAt: input.now,
      });
    }
    await fs.writeFile(file, JSON.stringify(points, null, 2) + "\n");
  }

  async loadFailureModes(repo: string): Promise<FailureModeRecord[]> {
    try {
      const raw = await fs.readFile(path.join(this.dir(repo), "failuremodes.json"), "utf8");
      return JSON.parse(raw) as FailureModeRecord[];
    } catch {
      return [];
    }
  }

  /**
   * List the repos that have a memory directory on disk (IN-625, `vf memory ls`). The on-disk
   * name is a slug of the repo, but every stored TestPoint carries its original `repo` string —
   * we read that back so callers see `owner/name`, not the slug.
   */
  async listRepos(): Promise<Array<{ slug: string; repo: string; testPoints: number; failureModes: number }>> {
    const memDir = path.join(this.root, "memory");
    let entries: string[];
    try {
      entries = (await fs.readdir(memDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }
    const out: Array<{ slug: string; repo: string; testPoints: number; failureModes: number }> = [];
    for (const slugName of entries.sort()) {
      const points = await this.loadTestPointsBySlug(slugName);
      const failureModes = await this.loadFailureModesBySlug(slugName);
      // Skip empty-but-present directories (e.g. an interrupted `clear` mid-write): they carry no
      // test points to recover the original `owner/repo` string from, so listing them would show
      // the hashed slug. Nothing to inspect there anyway.
      if (points.length === 0 && failureModes.length === 0) continue;
      out.push({
        slug: slugName,
        repo: points[0]?.repo ?? slugName,
        testPoints: points.length,
        failureModes: failureModes.length,
      });
    }
    return out;
  }

  private async loadTestPointsBySlug(slugName: string): Promise<TestPoint[]> {
    try {
      const raw = await fs.readFile(path.join(this.root, "memory", slugName, "testpoints.json"), "utf8");
      return JSON.parse(raw) as TestPoint[];
    } catch {
      return [];
    }
  }

  private async loadFailureModesBySlug(slugName: string): Promise<FailureModeRecord[]> {
    try {
      const raw = await fs.readFile(path.join(this.root, "memory", slugName, "failuremodes.json"), "utf8");
      return JSON.parse(raw) as FailureModeRecord[];
    } catch {
      return [];
    }
  }

  /**
   * Find a single stored test point by its id, across all repos (IN-625, `vf memory show <key>`).
   * O(repos × points): a sequential scan that reads every repo's test-point file. Fine for the
   * typical memory size; revisit (e.g. an id→repo index) if the store ever grows large.
   */
  async findTestPoint(id: string): Promise<TestPoint | undefined> {
    for (const r of await this.listRepos()) {
      const points = await this.loadTestPointsBySlug(r.slug);
      const hit = points.find((p) => p.id === id);
      if (hit) return hit;
    }
    return undefined;
  }

  /**
   * Clear the on-disk memory (IN-625, `vf memory clear`). With `repo`, only that repo's memory
   * directory is removed; without it, the whole memory tree is wiped. Returns the repo slugs that
   * were removed (empty when there was nothing to clear).
   */
  async clear(repo?: string): Promise<string[]> {
    if (repo) {
      const dir = this.dir(repo);
      // Defence in depth: slug() already strips path separators, so traversal can't reach outside
      // the store today — but assert that invariant explicitly so a future slug() change can't turn
      // `clear()` into an arbitrary `rm`. The resolved dir must stay strictly inside <root>/memory.
      const memRoot = path.join(this.root, "memory");
      const rel = path.relative(memRoot, dir);
      // Compare on path segments, not the raw string: a legitimate slug can begin with ".." (e.g.
      // `.._.._x`) yet still resolve inside the store. Traversal means an upward `..` segment or an
      // absolute path; the empty rel means `dir` IS the memory root (would wipe everything).
      const escapes = rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
      if (escapes) {
        throw new Error(`refusing to clear memory outside the store: ${repo}`);
      }
      // Single rm (no `force`, so ENOENT surfaces) instead of stat→rm — no TOCTOU window. A
      // caught ENOENT means nothing was stored for this repo.
      try {
        await fs.rm(dir, { recursive: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
      return [slug(repo)];
    }
    const repos = (await this.listRepos()).map((r) => r.slug);
    await fs.rm(path.join(this.root, "memory"), { recursive: true, force: true });
    return repos;
  }

  async recordFailureMode(
    repo: string,
    category: FailureCategory,
    component: string,
    now: string,
  ): Promise<void> {
    const dir = this.dir(repo);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "failuremodes.json");
    let records: FailureModeRecord[] = [];
    try {
      records = JSON.parse(await fs.readFile(file, "utf8")) as FailureModeRecord[];
    } catch {
      /* none yet */
    }
    const hit = records.find((r) => r.category === category && r.component === component);
    if (hit) {
      hit.count += 1;
      hit.lastSeen = now;
    } else {
      records.push({ category, component, count: 1, lastSeen: now });
    }
    await fs.writeFile(file, JSON.stringify(records, null, 2) + "\n");
  }

  // --- False-positive feedback (IN-792) -------------------------------------------------------

  async loadFeedback(repo: string): Promise<FeedbackRecord[]> {
    try {
      const raw = await fs.readFile(path.join(this.dir(repo), "feedback.json"), "utf8");
      return JSON.parse(raw) as FeedbackRecord[];
    } catch {
      return [];
    }
  }

  private async loadFeedbackBySlug(slugName: string): Promise<FeedbackRecord[]> {
    try {
      const raw = await fs.readFile(path.join(this.root, "memory", slugName, "feedback.json"), "utf8");
      return JSON.parse(raw) as FeedbackRecord[];
    } catch {
      return [];
    }
  }

  /** Record (upsert by normalized criterion text) a false-positive correction for a repo. */
  async recordFeedback(repo: string, record: FeedbackRecord): Promise<void> {
    const dir = this.dir(repo);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "feedback.json");
    const records = await this.loadFeedback(repo);
    // Stamp the repo so listing can recover owner/repo without a sibling test point.
    const full: FeedbackRecord = { ...record, repo };
    const key = norm(full.criterionText);
    const existing = records.find((r) => norm(r.criterionText) === key);
    if (existing) {
      existing.note = full.note;
      existing.runId = full.runId;
      existing.createdAt = full.createdAt;
      existing.repo = repo;
    } else {
      records.push(full);
    }
    await fs.writeFile(file, JSON.stringify(records, null, 2) + "\n");
  }

  /** Disk-backed match of a criterion against a repo's stored feedback (see matchFeedbackRecords). */
  async matchFeedback(repo: string, criterionText: string): Promise<FeedbackRecord | undefined> {
    return matchFeedbackRecords(await this.loadFeedback(repo), criterionText);
  }

  /** List repos that have stored feedback, with counts (`vf feedback ls`). */
  async listFeedback(): Promise<Array<{ slug: string; repo: string; count: number }>> {
    const memDir = path.join(this.root, "memory");
    let entries: string[];
    try {
      entries = (await fs.readdir(memDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }
    const out: Array<{ slug: string; repo: string; count: number }> = [];
    for (const slugName of entries.sort()) {
      const records = await this.loadFeedbackBySlug(slugName);
      if (records.length === 0) continue;
      // Prefer the repo stamped on the record; fall back to a sibling test point, then the slug.
      const points = await this.loadTestPointsBySlug(slugName);
      const repo = records[0]?.repo ?? points[0]?.repo ?? slugName;
      out.push({ slug: slugName, repo, count: records.length });
    }
    return out;
  }

  /**
   * Remove stored feedback (`vf feedback clear`): one repo's feedback.json, or every repo's. Reuses
   * the same path-traversal guard as `clear()` so a crafted `--repo` can't escape the store.
   */
  async clearFeedback(repo?: string): Promise<string[]> {
    if (repo) {
      const dir = this.dir(repo);
      const memRoot = path.join(this.root, "memory");
      const rel = path.relative(memRoot, dir);
      const escapes = rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
      if (escapes) throw new Error(`refusing to clear feedback outside the store: ${repo}`);
      try {
        await fs.rm(path.join(dir, "feedback.json"));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
      return [slug(repo)];
    }
    const cleared: string[] = [];
    for (const r of await this.listFeedback()) {
      await fs.rm(path.join(this.root, "memory", r.slug, "feedback.json"), { force: true });
      cleared.push(r.slug);
    }
    return cleared;
  }
}
