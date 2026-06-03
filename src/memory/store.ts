import { promises as fs } from "node:fs";
import path from "node:path";
import type { CriterionResultValue, FailureCategory, Probe, TestPoint } from "../types.js";

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

interface FailureModeRecord {
  category: FailureCategory;
  component: string;
  count: number;
  lastSeen: string;
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
}
