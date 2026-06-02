import { promises as fs } from "node:fs";
import path from "node:path";
import type { CriterionResultValue, FailureCategory, Probe, TestPoint } from "../types.js";

const slug = (repo: string) => repo.replace(/[^a-zA-Z0-9._-]+/g, "_");
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

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

  /** Find a previously-stored probe for an equivalent criterion (the "feed-back" mechanism). */
  async matchTestPoint(repo: string, criterionText: string): Promise<TestPoint | undefined> {
    const points = await this.loadTestPoints(repo);
    const target = norm(criterionText);
    return points.find((p) => norm(p.criterionText) === target);
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
