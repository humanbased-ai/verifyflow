import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * `vf init` (IN-611): scaffold a per-repo `verifyflow.config.json` so a target repo can declare
 * how VerifyFlow sets it up and runs its tests, instead of relying on ecosystem inference. Pure
 * filesystem logic, separated from the CLI wrapper for testability.
 */

export const CONFIG_FILENAME = "verifyflow.config.json";

/** The scaffold written by `vf init`. Fields mirror what `loadRepoConfig` reads (repoConfig.ts). */
export function defaultConfig(): Record<string, unknown> {
  return {
    "//": "VerifyFlow per-repo config. Commands run inside the PR checkout. Edit for your stack.",
    setup: ["npm ci || npm install"],
    test: "npm test",
    runPrefix: "",
    testGlobPrefix: "",
  };
}

export interface InitResult {
  /** True when a new config file was written; false when one already existed (never overwritten). */
  created: boolean;
  path: string;
  reason?: string;
}

/** Write the scaffold to <cwd>/verifyflow.config.json, refusing to clobber an existing file. */
export async function runInit(cwd: string): Promise<InitResult> {
  const target = path.join(cwd, CONFIG_FILENAME);
  try {
    await fs.access(target);
    return { created: false, path: target, reason: "already exists — left untouched" };
  } catch {
    // Does not exist — safe to write.
  }
  await fs.writeFile(target, JSON.stringify(defaultConfig(), null, 2) + "\n");
  return { created: true, path: target };
}
