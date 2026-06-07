import { promises as fs } from "node:fs";
import path from "node:path";
import type { VerifyflowFileConfig } from "../core/planner/repoConfig.js";
import { inferEcosystem } from "../core/planner/repoConfig.js";

/**
 * `vf init` (IN-611): scaffold a per-repo `verifyflow.config.json` so a target repo can declare
 * how VerifyFlow sets it up and runs its tests, instead of relying on ecosystem inference. Pure
 * filesystem logic, separated from the CLI wrapper for testability.
 *
 * The scaffold's shape is `VerifyflowFileConfig`, owned by repoConfig.ts (the reader), so the
 * writer here and the loader there can never drift.
 */

export const CONFIG_FILENAME = "verifyflow.config.json";

/** Fallback scaffold used when no ecosystem is detected. */
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
  /** What ecosystem was auto-detected, if any. */
  detected?: string;
  reason?: string;
}

/**
 * Write the scaffold to <cwd>/verifyflow.config.json, refusing to clobber an existing file.
 * Auto-detects the repo ecosystem (Python/uv, Node/npm, Go, Rust, …) and generates the
 * appropriate setup/test commands. Falls back to a generic npm template when nothing is detected.
 * Creates the target directory if it does not exist.
 */
export async function runInit(cwd: string): Promise<InitResult> {
  await fs.mkdir(cwd, { recursive: true });

  const target = path.join(cwd, CONFIG_FILENAME);

  // Try ecosystem detection; fall back to generic template when nothing is recognized.
  const detected = await inferEcosystem(cwd);
  const config = detected?.config ?? defaultConfig();

  try {
    await fs.writeFile(target, JSON.stringify(config, null, 2) + "\n", { flag: "wx" });
    return { created: true, path: target, detected: detected?.source };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return { created: false, path: target, reason: "already exists — left untouched" };
    }
    throw err;
  }
}
