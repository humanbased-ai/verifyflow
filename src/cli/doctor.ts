import { hasBinary } from "../util/exec.js";
import { resolveLinearApiKey } from "./credentials.js";

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
  /** Whether Playwright is importable (the ui-level browser backend). Injectable for tests. */
  hasPlaywright?: () => Promise<boolean>;
  /**
   * Resolve the Linear API key (env first, then ~/.verifyflow/credentials.json). Injectable so
   * tests don't depend on the user's real credentials file.
   */
  resolveLinearKey?: (env: NodeJS.ProcessEnv) => Promise<string | undefined>;
}

/** Default Playwright probe: is the optional `playwright` module importable? */
async function playwrightImportable(): Promise<boolean> {
  try {
    // Non-literal specifier so TS/bundlers don't require the optional dep to be installed.
    const name = "playwright";
    await import(name);
    return true;
  } catch {
    return false;
  }
}

export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorReport> {
  const env = deps.env ?? process.env;
  const hasBin = deps.hasBin ?? hasBinary;
  const hasPlaywright = deps.hasPlaywright ?? playwrightImportable;
  const resolveLinear = deps.resolveLinearKey ?? ((e) => resolveLinearApiKey(e));

  const [gh, claude, uv, docker, podman, playwright, linearKey] = await Promise.all([
    hasBin("gh"),
    hasBin("claude"),
    hasBin("uv"),
    hasBin("docker"),
    hasBin("podman"),
    hasPlaywright(),
    resolveLinear(env),
  ]);
  const linear = Boolean(linearKey);
  const linearSource = env.LINEAR_API_KEY ? "env" : linearKey ? "credentials file" : null;
  // Either container runtime satisfies the sandbox prerequisite (IN-555).
  const sandbox = docker || podman;
  const sandboxRuntime = docker ? "docker" : podman ? "podman" : null;

  const checks: DoctorCheck[] = [
    { name: "gh", ok: gh, required: true, detail: gh ? "found" : "not found on PATH — needed for GitHub PR context" },
    {
      name: "LINEAR_API_KEY",
      ok: linear,
      required: true,
      detail: linear
        ? `set (${linearSource})`
        : "not set — needed for live Linear issue access (or use --fixtures)",
    },
    { name: "claude", ok: claude, required: false, detail: claude ? "found" : "not found — VerifyFlow falls back to the deterministic LLM backend" },
    { name: "uv", ok: uv, required: false, detail: uv ? "found" : "not found — only needed for python-uv target repos" },
    {
      name: "sandbox (docker/podman)",
      ok: sandbox,
      required: false,
      detail: sandbox
        ? `found (${sandboxRuntime}) — sandbox isolation for executing PR code (IN-555) available`
        : "neither docker nor podman found — sandbox isolation (IN-555) unavailable; probes run on the host",
    },
    {
      name: "playwright",
      ok: playwright,
      required: false,
      detail: playwright
        ? "installed — `--level ui` browser checks available"
        : "not installed — needed for `--level ui`; install with `npm i -D playwright && npx playwright install chromium`",
    },
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
  lines.push(
    report.ok
      ? "doctor: all required tools are ready."
      : "doctor: missing required tools (see FAIL above). Run `vf onboard` for a guided fix.",
  );
  return lines.join("\n");
}
