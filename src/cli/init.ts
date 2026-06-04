import { promises as fs } from "node:fs";
import path from "node:path";
import type { VerifyflowFileConfig } from "../core/planner/repoConfig.js";

/**
 * `vf init` (IN-611): scaffold a per-repo `verifyflow.config.json` so a target repo can declare
 * how VerifyFlow sets it up and runs its tests, instead of relying on ecosystem inference. Pure
 * filesystem logic, separated from the CLI wrapper for testability.
 *
 * The scaffold's shape is `VerifyflowFileConfig`, owned by repoConfig.ts (the reader), so the
 * writer here and the loader there can never drift.
 */

export const CONFIG_FILENAME = "verifyflow.config.json";

/** The scaffold written by `vf init` (every field populated, hence Required). */
export function defaultConfig(): Required<VerifyflowFileConfig> {
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

/**
 * Write the scaffold to <cwd>/verifyflow.config.json, refusing to clobber an existing file.
 * Uses an exclusive-create write (`flag: "wx"`) so the existence check and the write are atomic —
 * no TOCTOU window between checking and writing.
 */
export async function runInit(cwd: string): Promise<InitResult> {
  const target = path.join(cwd, CONFIG_FILENAME);
  try {
    await fs.writeFile(target, JSON.stringify(defaultConfig(), null, 2) + "\n", { flag: "wx" });
    return { created: true, path: target };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return { created: false, path: target, reason: "already exists — left untouched" };
    }
    throw err;
  }
}
