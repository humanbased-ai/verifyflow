import type { LlmClient } from "../backends/llm.js";
import { adaptCommand, type RepoConfig } from "../core/planner/repoConfig.js";
import { extractJson } from "../util/json.js";

/**
 * Ask the LLM to repair a probe command that failed with an environment/command error
 * (not a product failure). Used by the probe self-check loop (IN-552): rather than scoring a
 * criterion as blocked because OUR command was malformed, we regenerate a corrected command
 * and re-run it.
 *
 * Returns a repo-adapted command string, or undefined when the model offers nothing usable
 * (e.g. the deterministic fallback, or an unchanged command).
 */
export async function regenerateProbe(opts: {
  criterionText: string;
  failedCommand: string;
  errorOutput: string;
  cfg: RepoConfig;
  llm: LlmClient;
}): Promise<string | undefined> {
  const system =
    "You are VerifyFlow's probe repair tool. A shell probe meant to CHECK an acceptance " +
    "criterion failed with an ENVIRONMENT or COMMAND error (not a product failure) — e.g. a " +
    "malformed command, wrong working directory, or an interpreter that bypassed the project " +
    "environment. Produce a corrected probe that actually exercises the criterion. Rules: return " +
    "ONE single shell command (no multi-line scripts); do not assume tools outside the repo's " +
    "toolchain; exit 0 means the criterion holds. JSON only.";
  const prompt = [
    `Acceptance criterion: ${opts.criterionText}`,
    `Failed command: ${opts.failedCommand}`,
    "Error output (this is OUR probe breaking, not the product):",
    opts.errorOutput.slice(0, 800),
    "",
    'Respond: {"command":"<corrected single shell command>"}.',
  ].join("\n");

  let raw: string;
  try {
    raw = await opts.llm.complete({ system, prompt, task: "probe-repair", tier: "smart" });
  } catch {
    return undefined;
  }
  let command: string | undefined;
  try {
    command = extractJson<{ command?: string }>(raw).command?.trim();
  } catch {
    return undefined;
  }
  if (!command) return undefined;

  const adapted = adaptCommand(command, opts.cfg);
  // No point retrying with the identical command.
  if (adapted.trim() === opts.failedCommand.trim()) return undefined;
  return adapted;
}
