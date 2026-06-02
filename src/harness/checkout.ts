import { promises as fs } from "node:fs";
import path from "node:path";
import { run } from "../util/exec.js";

const slug = (repo: string) => repo.replace(/[^a-zA-Z0-9._-]+/g, "_");

export interface CheckoutResult {
  workdir: string;
  checkedOut: string; // sha or ref actually checked out
  logs: string[];
}

/**
 * Clone (or reuse) the target repo and check out the PR head, so the harness verifies the
 * exact delivered code. Uses git + the authorized `gh`; no credentials are stored by VerifyFlow.
 */
export async function ensurePrCheckout(opts: {
  repo: string;
  prNumber: number;
  headSha: string;
  baseDir: string;
}): Promise<CheckoutResult> {
  const logs: string[] = [];
  const dir = path.join(opts.baseDir, ".targets", slug(opts.repo));
  const exists = await fs
    .access(path.join(dir, ".git"))
    .then(() => true)
    .catch(() => false);

  const log = (label: string, r: { code: number | null; stderr: string; executed: boolean }) => {
    logs.push(`${label}: exit=${r.code} executed=${r.executed}${r.stderr ? ` err=${r.stderr.slice(0, 200)}` : ""}`);
    if (!r.executed || (r.code !== 0 && !label.startsWith("fetch-head")))
      throw new Error(`${label} failed: ${r.stderr.slice(0, 300) || "spawn error"}`);
  };

  if (!exists) {
    await fs.mkdir(path.dirname(dir), { recursive: true });
    log("clone", await run("gh", ["repo", "clone", opts.repo, dir, "--", "--no-tags"]));
  } else {
    log("fetch", await run("git", ["-C", dir, "fetch", "origin", "--prune"]));
  }

  // Fetch the PR head ref, then check out the exact sha.
  log(
    "fetch-pr",
    await run("git", ["-C", dir, "fetch", "origin", `pull/${opts.prNumber}/head`]),
  );
  const co = await run("git", ["-C", dir, "checkout", "--force", opts.headSha]);
  if (!co.executed || co.code !== 0) {
    // Fall back to FETCH_HEAD when the sha is not directly resolvable.
    log("checkout-fetch-head", await run("git", ["-C", dir, "checkout", "--force", "FETCH_HEAD"]));
    return { workdir: dir, checkedOut: "FETCH_HEAD", logs };
  }
  logs.push(`checkout: ${opts.headSha}`);
  return { workdir: dir, checkedOut: opts.headSha, logs };
}
