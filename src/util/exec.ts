import { spawn } from "node:child_process";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** False when the process could not be spawned at all (binary missing, etc.). */
  executed: boolean;
  /** True when the process was killed because it exceeded timeoutMs. */
  timedOut: boolean;
  spawnError?: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  /** Hard cap on captured stdout/stderr to avoid unbounded buffers. */
  maxBuffer?: number;
  /**
   * When true, run the command through the platform's default shell (cmd.exe on Windows,
   * /bin/sh elsewhere). Required for command lines containing shell operators like `||`/`&&`.
   * For the common case `spawn(cmd, [], { shell: true })` lets the shell interpret the whole
   * command string verbatim.
   */
  shell?: boolean;
}

/**
 * Run a command and fully capture stdout/stderr. Never throws — failures are reported
 * in the result so the harness can distinguish product failure from environment failure.
 */
export function run(
  command: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const maxBuffer = opts.maxBuffer ?? 5_000_000;
  const startedAt = process.hrtime.bigint();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: opts.shell,
      });
    } catch (err) {
      resolve({
        code: null,
        stdout: "",
        stderr: "",
        durationMs: 0,
        executed: false,
        timedOut: false,
        spawnError: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          if (!settled) {
            timedOut = true;
            child.kill("SIGKILL");
          }
        }, opts.timeoutMs)
      : undefined;

    const finish = (code: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      resolve({
        code,
        stdout,
        stderr,
        durationMs: Math.round(durationMs),
        executed: spawnError === undefined,
        timedOut,
        spawnError,
      });
    };

    child.stdout.on("data", (d) => {
      if (stdout.length < maxBuffer) stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < maxBuffer) stderr += d.toString();
    });
    child.on("error", (err) => finish(null, err.message));
    child.on("close", (code) => finish(code));

    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

/** Whether a binary is resolvable on PATH. */
export async function hasBinary(name: string): Promise<boolean> {
  const res = await run(process.platform === "win32" ? "where" : "which", [name]);
  return res.executed && res.code === 0 && res.stdout.trim().length > 0;
}
