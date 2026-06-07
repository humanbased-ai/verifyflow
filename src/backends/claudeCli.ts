import { run, hasBinary } from "../util/exec.js";
import type { LlmClient, LlmRequest } from "./llm.js";

/** Patterns in stderr that indicate a transient, retriable condition. */
const RETRIABLE = /rate.?limit|429|529|overload|too many requests/i;

/**
 * LLM backend that uses the authorized `claude` CLI (Claude Code) in headless print mode.
 * Auth comes from the user's existing `claude` login — VerifyFlow stores no API key.
 *
 *   claude -p "<prompt>" --output-format json [--model <m>] [--append-system-prompt <s>]
 *
 * The JSON envelope looks like { "type":"result", "result":"<text>", ... }; we return `.result`.
 * Transient errors (rate-limit, overload) are retried up to `maxRetries` times with exponential
 * backoff before the error is propagated.
 */
export class ClaudeCliClient implements LlmClient {
  readonly name = "claude-cli";
  private readonly bin: string;
  private readonly model?: string;
  private readonly fastModel: string;
  private readonly smartModel: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(opts: {
    bin?: string;
    model?: string;
    fastModel?: string;
    smartModel?: string;
    timeoutMs?: number;
    maxRetries?: number;
    retryDelayMs?: number;
  } = {}) {
    this.bin = opts.bin ?? "claude";
    this.model = opts.model; // explicit override — wins over tier
    this.fastModel = opts.fastModel ?? "claude-haiku-4-5-20251001";
    this.smartModel = opts.smartModel ?? "claude-sonnet-4-6";
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryDelayMs = opts.retryDelayMs ?? 1_000;
  }

  async available(): Promise<boolean> {
    return hasBinary(this.bin);
  }

  /** Human-readable description of which model handles which tier — for dry-run output. */
  modelDescription(): string {
    if (this.model) return `all calls → ${this.model} (--model override)`;
    return `fast calls (criteria/substring) → ${this.fastModel}; smart calls (verdict/probe-repair/ui/journey) → ${this.smartModel}`;
  }

  async complete(req: LlmRequest): Promise<string> {
    const model = this.model ?? (req.tier === "fast" ? this.fastModel : this.smartModel);
    const args = ["-p", req.prompt, "--output-format", "json"];
    args.push("--model", model);
    if (req.system) args.push("--append-system-prompt", req.system);

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const delayMs = this.retryDelayMs * Math.pow(2, attempt - 1);
        console.error(
          `[verifyflow] LLM transient error (attempt ${attempt}/${this.maxRetries}): ${lastError?.message.slice(0, 120)} — retrying in ${Math.round(delayMs / 1000)}s...`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }

      const res = await run(this.bin, args, { timeoutMs: this.timeoutMs });
      if (!res.executed) {
        // Binary not found — not retriable.
        throw new Error(`claude CLI not executable: ${res.spawnError ?? "unknown"}`);
      }
      if (res.code !== 0) {
        const errText = res.stderr.slice(0, 500) || res.stdout.slice(0, 500);
        const err = new Error(`claude CLI exited ${res.code}: ${errText}`);
        if (RETRIABLE.test(errText) && attempt < this.maxRetries) {
          lastError = err;
          continue;
        }
        throw err;
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

    throw lastError!;
  }
}
