import { hasBinary } from "../util/exec.js";

/**
 * `vf doctor` (IN-611): report whether the CLIs and env VerifyFlow relies on are present, so a
 * newcomer can diagnose a broken setup before a real run. VerifyFlow stores no secrets — it
 * leans on already-authorized tools — so "ready" means those tools resolve.
 *
 * Probes are injectable so the check logic is unit-testable without touching the real PATH/env.
 */

export interface DoctorCheck {
  name: string;
  ok: boolean;
  /** A missing required tool fails `doctor`; a missing optional one only warns. */
  required: boolean;
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** True when every required check passed (optional misses don't fail). */
  ok: boolean;
}

export interface DoctorDeps {
  env?: NodeJS.ProcessEnv;
  hasBin?: (name: string) => Promise<boolean>;
}

export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorReport> {
  const env = deps.env ?? process.env;
  const hasBin = deps.hasBin ?? hasBinary;

  const [gh, claude, uv] = await Promise.all([hasBin("gh"), hasBin("claude"), hasBin("uv")]);
  const linear = Boolean(env.LINEAR_API_KEY);

  const checks: DoctorCheck[] = [
    { name: "gh", ok: gh, required: true, detail: gh ? "found" : "not found on PATH — needed for GitHub PR context" },
    { name: "LINEAR_API_KEY", ok: linear, required: true, detail: linear ? "set" : "not set — needed for live Linear issue access (or use --fixtures)" },
    { name: "claude", ok: claude, required: false, detail: claude ? "found" : "not found — VerifyFlow falls back to the deterministic LLM backend" },
    { name: "uv", ok: uv, required: false, detail: uv ? "found" : "not found — only needed for python-uv target repos" },
  ];
  const ok = checks.every((c) => c.ok || !c.required);
  return { checks, ok };
}

/** Render a doctor report as human-readable lines for the CLI. */
export function renderDoctorReport(report: DoctorReport): string {
  const lines = report.checks.map((c) => {
    const mark = (c.ok ? "ok" : c.required ? "FAIL" : "WARN").padEnd(4);
    return `  [${mark}] ${c.name}: ${c.detail}`;
  });
  lines.push("");
  lines.push(report.ok ? "doctor: all required tools are ready." : "doctor: missing required tools (see FAIL above).");
  return lines.join("\n");
}
