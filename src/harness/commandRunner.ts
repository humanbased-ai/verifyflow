import { promises as fs } from "node:fs";
import path from "node:path";
import { run } from "../util/exec.js";
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
  probeMs: 60_000, // a CLI probe should be fast; a hang is a signal
  testMs: 240_000, // scoped tests; bounded so one hung test can't stall the run
  defaultMs: 180_000,
};

export class CommandRunner {
  private readonly timeouts: CommandRunnerTimeouts;
  constructor(
    private readonly workdir: string,
    private readonly artifactRoot: string,
    timeouts: Partial<CommandRunnerTimeouts> = {},
  ) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };
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
    const res = await run("sh", ["-c", step.command], {
      cwd,
      timeoutMs: this.timeoutFor(step.id),
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
      { type: "command_output", path: relLog, summary: `output of \`${step.command}\`` },
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
