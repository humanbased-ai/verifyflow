import { run, hasBinary } from "../util/exec.js";
import type { LlmClient, LlmRequest } from "./llm.js";

/**
 * LLM backend that uses the authorized `claude` CLI (Claude Code) in headless print mode.
 * Auth comes from the user's existing `claude` login — VerifyFlow stores no API key.
 *
 *   claude -p "<prompt>" --output-format json [--model <m>] [--append-system-prompt <s>]
 *
 * The JSON envelope looks like { "type":"result", "result":"<text>", ... }; we return `.result`.
 */
export class ClaudeCliClient implements LlmClient {
  readonly name = "claude-cli";
  private readonly bin: string;
  private readonly model?: string;
  private readonly fastModel: string;
  private readonly smartModel: string;
  private readonly timeoutMs: number;

  constructor(opts: { bin?: string; model?: string; fastModel?: string; smartModel?: string; timeoutMs?: number } = {}) {
    this.bin = opts.bin ?? "claude";
    this.model = opts.model; // explicit override — wins over tier
    this.fastModel = opts.fastModel ?? "claude-haiku-4-5-20251001";
    this.smartModel = opts.smartModel ?? "claude-sonnet-4-6";
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async available(): Promise<boolean> {
    return hasBinary(this.bin);
  }

  async complete(req: LlmRequest): Promise<string> {
    const model = this.model ?? (req.tier === "fast" ? this.fastModel : this.smartModel);
    const args = ["-p", req.prompt, "--output-format", "json"];
    args.push("--model", model);
    if (req.system) args.push("--append-system-prompt", req.system);

    const res = await run(this.bin, args, { timeoutMs: this.timeoutMs });
    if (!res.executed) {
      throw new Error(`claude CLI not executable: ${res.spawnError ?? "unknown"}`);
    }
    if (res.code !== 0) {
      throw new Error(
        `claude CLI exited ${res.code}: ${res.stderr.slice(0, 500) || res.stdout.slice(0, 500)}`,
      );
    }
    // Parse the JSON envelope; fall back to raw stdout if it is already plain text.
    try {
      const env = JSON.parse(res.stdout) as { result?: string; error?: string };
      if (typeof env.result === "string") return env.result;
      if (env.error) throw new Error(`claude CLI error: ${env.error}`);
    } catch {
      // not an envelope
    }
    return res.stdout;
  }
}
