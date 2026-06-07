import { promises as fs } from "node:fs";
import path from "node:path";
import { run } from "../util/exec.js";
import { sanitizeEnv } from "./sandbox.js";
import type { Evidence, HarnessResult, PlanStep } from "../types.js";

/**
 * Executes a plan step as a real subprocess and captures its output as addressable evidence.
 * This is the "real execution" core: VerifyFlow runs the code, it does not infer from the diff.
 */
export interface CommandRunnerTimeouts {
  setupMs: number;
  probeMs: number;
  testMs: number;
  defaultMs: number;
}

const DEFAULT_TIMEOUTS: CommandRunnerTimeouts = {
  setupMs: 600_000, // dependency install can be slow
  // A probe is usually a fast CLI invocation, but the planner can also pick the repo's own
  // test command as a probe (e.g. `npm test`), which legitimately runs for a minute or two.
  // 120s tolerates a real test suite while still catching a true hang.
  probeMs: 120_000,
  testMs: 240_000, // scoped tests; bounded so one hung test can't stall the run
  defaultMs: 180_000,
};

export interface CommandRunnerOptions {
  timeouts?: Partial<CommandRunnerTimeouts>;
  /** When true (default), strip host secrets from the env handed to commands (IN-555). */
  isolate?: boolean;
}

export class CommandRunner {
  private readonly timeouts: CommandRunnerTimeouts;
  private readonly isolate: boolean;
  constructor(
    private readonly workdir: string,
    private readonly artifactRoot: string,
    opts: CommandRunnerOptions = {},
  ) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
    this.isolate = opts.isolate ?? true;
  }

  private timeoutFor(stepId: string): number {
    if (stepId.startsWith("setup-")) return this.timeouts.setupMs;
    if (stepId.startsWith("probe-")) return this.timeouts.probeMs;
    if (stepId.startsWith("tests")) return this.timeouts.testMs;
    return this.timeouts.defaultMs;
  }

  async runStep(step: PlanStep): Promise<HarnessResult> {
    if (step.kind !== "command" || !step.command) {
      return {
        stepId: step.id,
        exitCode: null,
        stdout: "",
        stderr: "",
        durationMs: 0,
        executed: false,
        timedOut: false,
        evidence: [],
      };
    }

    let cwd = path.resolve(this.workdir, step.cwd ?? ".");
    const cwdExists = await fs
      .stat(cwd)
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (!cwdExists) cwd = path.resolve(this.workdir);
    // Use the platform's default shell (cmd.exe on Windows, /bin/sh elsewhere) so command
    // lines with shell operators like `npm ci || npm install` work everywhere. Previously we
    // hardcoded `sh -c`, which failed with `spawn sh ENOENT` on stock Windows PowerShell.
    const res = await run(step.command, [], {
      cwd,
      timeoutMs: this.timeoutFor(step.id),
      env: sanitizeEnv(process.env, this.isolate),
      shell: true,
    });

    await fs.mkdir(this.artifactRoot, { recursive: true });
    const logName = `${step.id}.log`;
    const logPath = path.join(this.artifactRoot, logName);
    const header =
      `$ ${step.command}\n(cwd: ${cwd})\n(exit: ${res.code}, executed: ${res.executed}` +
      (res.timedOut ? `, TIMED OUT after ${res.durationMs}ms` : "") +
      (res.spawnError ? `, spawnError: ${res.spawnError}` : "") +
      `)\n${"-".repeat(60)}\n`;
    await fs.writeFile(logPath, header + res.stdout + (res.stderr ? `\n[stderr]\n${res.stderr}` : ""));

    const relLog = path.relative(this.artifactRoot, logPath);
    const evidence: Evidence[] = [
      {
        type: "command_output",
        path: relLog,
        summary: `output of \`${step.command}\``,
        excerpt: buildEvidenceExcerpt(header, res.stdout, res.stderr),
      },
    ];
    if (/\b(pytest|jest|vitest|go test|cargo test|npm test|unittest)\b/.test(step.command)) {
      evidence.push({ type: "test_report", path: relLog, summary: "test runner output" });
    }

    return {
      stepId: step.id,
      command: step.command,
      cwd,
      exitCode: res.code,
      stdout: res.stdout,
      stderr: res.stderr,
      durationMs: res.durationMs,
      executed: res.executed,
      timedOut: res.timedOut,
      evidence,
    };
  }
}

/**
 * Inline excerpt of a command's evidence for the report/PR comment (IN-579).
 * Artifacts live on the runner's disk, unreachable from GitHub — the excerpt travels
 * with the Evidence so a PR reviewer can see the actual output. Head + tail are kept
 * (failures usually surface at the end) with an explicit truncation marker between.
 */
export function buildEvidenceExcerpt(
  header: string,
  stdout: string,
  stderr: string,
  maxChars = 1200,
): string {
  const body = stdout + (stderr ? `\n[stderr]\n${stderr}` : "");
  const full = header + body;
  if (full.length <= maxChars) return full;
  const headBudget = Math.max(header.length, Math.floor(maxChars * 0.6));
  const tailBudget = maxChars - headBudget;
  const truncated = full.length - headBudget - tailBudget;
  return (
    full.slice(0, headBudget) +
    `\n… [${truncated} chars truncated — full log: see artifact] …\n` +
    full.slice(-tailBudget)
  );
}
