/**
 * LLM backend boundary. VerifyFlow owns the contract; the model is an interchangeable
 * backend (architecture.md "Execution Backend Boundary"). The default backend shells out
 * to the authorized `claude` CLI in the environment — no raw API key is stored.
 */
export interface LlmRequest {
  system: string;
  prompt: string;
  /** A label used only for logs. */
  task: string;
}

export interface LlmClient {
  readonly name: string;
  available(): Promise<boolean>;
  /** Return raw model text. Callers extract JSON. */
  complete(req: LlmRequest): Promise<string>;
}
