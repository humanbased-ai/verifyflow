import type { LlmClient, LlmRequest } from "./llm.js";

/**
 * Deterministic, dependency-free fallback used when the `claude` CLI is unavailable
 * (offline, CI without auth) and in unit tests. It is intentionally NOT a real model:
 * it returns empty structured envelopes so the deterministic extractors in the parser
 * and verdict engine take over. This keeps the pipeline runnable and hermetically
 * testable without ever guessing — empty means "no LLM signal", not "invented signal".
 */
export class FallbackLlm implements LlmClient {
  readonly name = "fallback-deterministic";
  async available(): Promise<boolean> {
    return true;
  }
  async complete(_req: LlmRequest): Promise<string> {
    return "{}";
  }
}
