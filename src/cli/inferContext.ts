import { run as defaultRun } from "../util/exec.js";

/**
 * IN-678: zero-config adaptive CLI. When run inside a repo checkout, fill omitted context from the
 * environment so `vf run` works with no flags. Purely ADDITIVE — every inference only fires when the
 * corresponding flag is absent, and an explicit flag always wins. Only `vf run` calls this; `vf step`
 * / `vf watch` always pass their context explicitly, so their behavior is unchanged.
 */

type Runner = typeof defaultRun;

export interface InferDeps {
  run?: Runner;
  cwd?: string;
}

export interface PrInference {
  /** A PR ref (full URL, owner/repo#N, or #N) when one could be resolved. */
  ref?: string;
  /** Why inference failed — surfaced to the user so they know what to pass. */
  reason?: string;
}

/** True when `cwd` is inside a git work tree. */
export async function inGitRepo(deps: InferDeps = {}): Promise<boolean> {
  const run = deps.run ?? defaultRun;
  const res = await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: deps.cwd });
  return res.executed && res.code === 0 && res.stdout.trim() === "true";
}

/**
 * Infer the PR ref for the current git branch via `gh pr view`. Returns `{ ref }` on success or
 * `{ reason }` describing why not (no gh, not authenticated, or no open PR for the branch).
 */
export async function inferPrRef(deps: InferDeps = {}): Promise<PrInference> {
  const run = deps.run ?? defaultRun;
  const res = await run("gh", ["pr", "view", "--json", "number,url"], { cwd: deps.cwd });
  if (!res.executed) return { reason: "`gh` CLI not found — install it or pass --pr explicitly" };
  if (res.code !== 0) {
    return { reason: "no open PR for the current branch (or `gh` not authenticated) — pass --pr" };
  }
  try {
    const parsed = JSON.parse(res.stdout) as { number?: number; url?: string };
    const ref = parsed.url ?? (parsed.number ? `#${parsed.number}` : undefined);
    return ref ? { ref } : { reason: "`gh pr view` returned no PR number/url — pass --pr" };
  } catch {
    return { reason: "could not parse `gh pr view` output — pass --pr" };
  }
}
