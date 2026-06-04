import type { MemoryStore } from "../memory/store.js";
import type { TestPoint } from "../types.js";

/**
 * `vf memory` (IN-625): inspect and prune the reusable test-point memory — the "gets smarter as
 * it runs" moat. Pure rendering/decision logic, separated from the CLI wrapper so it is unit
 * testable against a real on-disk MemoryStore without spawning a process.
 *
 * Subcommands:
 *   vf memory ls                  list repos with stored memory + counts
 *   vf memory show <key>          dump a single test point (by its id)
 *   vf memory clear [--repo ...]  delete memory (one repo, or all); asks to confirm unless --yes
 */

export interface MemoryLsResult {
  text: string;
  json: unknown;
}

export async function memoryLs(store: MemoryStore): Promise<MemoryLsResult> {
  const repos = await store.listRepos();
  const json = repos.map((r) => ({ repo: r.repo, testPoints: r.testPoints, failureModes: r.failureModes }));
  if (repos.length === 0) {
    return { text: "memory: empty — no test points stored yet (run `vf run` first).", json };
  }
  const lines = ["Stored memory (reusable test points):", ""];
  for (const r of repos) {
    lines.push(`- ${r.repo}: ${r.testPoints} test point(s), ${r.failureModes} failure mode(s)`);
  }
  lines.push("");
  lines.push("Inspect one with: vf memory show <key>   (key = a test point id)");
  return { text: lines.join("\n"), json };
}

export function renderTestPoint(p: TestPoint): string {
  const lines = [
    `Test point ${p.id}`,
    "",
    `  repo:        ${p.repo}`,
    `  component:   ${p.component}`,
    `  method:      ${p.method}`,
    `  criterion:   ${p.criterionText}`,
    `  probe:       ${p.probe.command}`,
  ];
  if (p.probe.expectSubstring) lines.push(`  expect:      output contains "${p.probe.expectSubstring}"`);
  if (p.probe.expectExitCode !== undefined) lines.push(`  expect exit: ${p.probe.expectExitCode}`);
  lines.push(`  fromTicket:  ${p.probe.fromTicket ? "yes" : "no"}`);
  lines.push(`  lastResult:  ${p.lastResult ?? "(none)"}`);
  lines.push(`  runs:        ${p.runs}`);
  lines.push(`  created:     ${p.createdAt}`);
  lines.push(`  updated:     ${p.updatedAt}`);
  return lines.join("\n");
}

export interface MemoryShowResult {
  found: boolean;
  text: string;
  point?: TestPoint;
}

export async function memoryShow(store: MemoryStore, key: string): Promise<MemoryShowResult> {
  const point = await store.findTestPoint(key);
  if (!point) {
    return { found: false, text: `memory: no test point with id "${key}" (list ids with \`vf memory ls\`).` };
  }
  return { found: true, text: renderTestPoint(point), point };
}

export interface MemoryClearResult {
  cleared: string[];
  text: string;
}

/**
 * Clear memory. Confirmation is the caller's responsibility (the CLI prompts unless `--yes`);
 * this performs the deletion and reports what was removed.
 */
export async function memoryClear(store: MemoryStore, repo?: string): Promise<MemoryClearResult> {
  // Snapshot the test-point counts before deletion so the success line can report how much was
  // actually removed ("N test point(s) across M repo(s)"), not just that something was cleared.
  const before = await store.listRepos();
  const cleared = await store.clear(repo);
  if (cleared.length === 0) {
    return { cleared, text: repo ? `memory: nothing stored for ${repo}.` : "memory: nothing to clear." };
  }
  const clearedSet = new Set(cleared);
  const points = before.filter((r) => clearedSet.has(r.slug)).reduce((n, r) => n + r.testPoints, 0);
  const repoCount = cleared.length;
  const scope = repo ? `for ${repo}` : `across ${repoCount} repo(s)`;
  return { cleared, text: `memory: cleared ${points} test point(s) ${scope}.` };
}
