import { runDoctor, type DoctorReport } from "./doctor.js";
import { run } from "../util/exec.js";

/**
 * `vf onboard` (#41): guided first-run setup. Doctor *diagnoses*; onboard *guides* — for each
 * missing prerequisite it prints the exact fix command for the user's platform (PowerShell on
 * Windows, POSIX shell elsewhere). Never stores secrets: pasted keys are echoed straight back
 * into a copy-pasteable export line, never persisted by VerifyFlow.
 */

export type OnboardStatus = "ok" | "fix" | "warn" | "info";

export interface OnboardStep {
  name: string;
  status: OnboardStatus;
  detail: string;
  /** Platform-specific commands or instructional lines for the user to run. */
  instructions: string[];
}

export interface OnboardReport {
  steps: OnboardStep[];
  /** True when no `fix` (required) step remains — warn/info entries do not block readiness. */
  ready: boolean;
  /** Suggested zero-credential smoke test the user can run to verify a green state. */
  smokeTest: string;
}

export interface OnboardDeps {
  /** Diagnostic backbone — defaults to `runDoctor()`. Tests inject a fixed report. */
  doctor?: () => Promise<DoctorReport>;
  /** Target platform for the printed commands. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** `gh auth status` probe — separate from binary presence (which doctor already reports). */
  ghAuthed?: () => Promise<boolean>;
  /**
   * Read a line from the user. Omit for non-interactive runs (CI / non-TTY) so onboard prints
   * generic instructions instead of blocking on stdin.
   */
  prompt?: (question: string) => Promise<string>;
}

function setEnvCommand(platform: NodeJS.Platform, name: string, value: string): string[] {
  if (platform === "win32") {
    return [
      "# PowerShell — current session only:",
      `$env:${name} = "${value}"`,
      "# PowerShell — persist for future sessions (user scope, reopen the shell to pick up):",
      `[Environment]::SetEnvironmentVariable("${name}", "${value}", "User")`,
    ];
  }
  return [
    "# POSIX shell — add to your rc file (~/.zshrc, ~/.bashrc, ~/.config/fish/config.fish, …) and reload:",
    `export ${name}="${value}"`,
  ];
}

async function defaultGhAuthed(): Promise<boolean> {
  const r = await run("gh", ["auth", "status"]);
  return r.executed && r.code === 0;
}

export async function runOnboard(deps: OnboardDeps = {}): Promise<OnboardReport> {
  const platform = deps.platform ?? process.platform;
  const doctor = deps.doctor ?? (() => runDoctor());
  const ghAuthed = deps.ghAuthed ?? defaultGhAuthed;
  const report = await doctor();
  const steps: OnboardStep[] = [];

  const findCheck = (predicate: (name: string) => boolean) =>
    report.checks.find((c) => predicate(c.name));

  // gh: doctor only knows whether the binary is on PATH. An installed-but-unauthenticated `gh` is
  // a distinct failure mode that doctor can't see — onboard probes it so the user gets the right
  // remediation (install vs login) instead of a misleading "gh: ok" followed by silent API 401s.
  const gh = findCheck((n) => n === "gh");
  if (gh && !gh.ok) {
    steps.push({
      name: "gh",
      status: "fix",
      detail: gh.detail,
      instructions: [
        "Install GitHub CLI: https://cli.github.com/",
        "Then authenticate: gh auth login",
      ],
    });
  } else if (gh) {
    const authed = await ghAuthed();
    steps.push(
      authed
        ? { name: "gh", status: "ok", detail: "installed and authenticated", instructions: [] }
        : {
            name: "gh",
            status: "fix",
            detail: "installed but not authenticated",
            instructions: ["Authenticate: gh auth login"],
          },
    );
  }

  // LINEAR_API_KEY: the FAIL most newcomers hit. Interactive flow inlines the pasted value into
  // a ready-to-run command; non-interactive uses a placeholder so the output still works in CI.
  const linear = findCheck((n) => n === "LINEAR_API_KEY");
  if (linear && !linear.ok) {
    const lines: string[] = [
      "Generate a personal API key in Linear: Settings → Account → Security & access → Personal API keys.",
    ];
    let pasted: string | undefined;
    if (deps.prompt) {
      const answer = (
        await deps.prompt(
          "Paste your Linear API key to get a ready-to-run command (or press Enter to skip): ",
        )
      ).trim();
      if (answer) pasted = answer;
    }
    const value = pasted ?? "<your-linear-api-key>";
    lines.push("");
    lines.push(...setEnvCommand(platform, "LINEAR_API_KEY", value));
    if (!pasted) {
      lines.push("");
      lines.push(
        "Replace <your-linear-api-key> with the value before running. " +
          "For offline runs you can skip this entirely and pass `--fixtures <dir>`.",
      );
    }
    steps.push({ name: "LINEAR_API_KEY", status: "fix", detail: linear.detail, instructions: lines });
  } else if (linear) {
    steps.push({ name: "LINEAR_API_KEY", status: "ok", detail: "set", instructions: [] });
  }

  // claude — optional but recommended: without it VerifyFlow uses the rules-only fallback backend.
  const claude = findCheck((n) => n === "claude");
  if (claude && !claude.ok) {
    steps.push({
      name: "claude",
      status: "warn",
      detail: claude.detail,
      instructions: [
        "Install Claude Code: https://docs.claude.com/en/docs/claude-code/overview",
        "Without it, VerifyFlow falls back to the deterministic rules-only backend (reduced quality, never blocks).",
      ],
    });
  } else if (claude) {
    steps.push({ name: "claude", status: "ok", detail: "installed", instructions: [] });
  }

  // playwright — only needed when the user actually runs `--level ui` or browser-backed journey
  // steps; surfaced as `info` rather than `warn` to avoid alarming a backend-only user.
  const pw = findCheck((n) => n === "playwright");
  if (pw && !pw.ok) {
    steps.push({
      name: "playwright",
      status: "info",
      detail: pw.detail,
      instructions: [
        "Only needed for `--level ui` (and browser steps in `--level journey`). Install on demand:",
        "  npm i -D playwright && npx playwright install chromium",
      ],
    });
  } else if (pw) {
    steps.push({ name: "playwright", status: "ok", detail: "installed", instructions: [] });
  }

  // uv — pure niche: only matters when verifying Python/uv target repos.
  const uv = findCheck((n) => n === "uv");
  if (uv && !uv.ok) {
    steps.push({
      name: "uv",
      status: "info",
      detail: uv.detail,
      instructions: [
        "Only needed if you verify Python (uv) target repos. Install: https://docs.astral.sh/uv/",
      ],
    });
  }

  // sandbox: docker/podman provides probe isolation (IN-555). Not yet load-bearing, hence `info`.
  const sandbox = findCheck((n) => n.startsWith("sandbox"));
  if (sandbox && !sandbox.ok) {
    steps.push({
      name: "sandbox",
      status: "info",
      detail: sandbox.detail,
      instructions: [
        "Optional: install Docker or Podman to enable probe sandbox isolation (IN-555). " +
          "Without it, probes run on the host.",
      ],
    });
  }

  const ready = steps.every((s) => s.status !== "fix");
  return {
    steps,
    ready,
    smokeTest:
      "npm run vf -- run --fixtures fixtures/example-cli --linear EX-1 --pr example/greet#7 --level functional",
  };
}

const ICON: Record<OnboardStatus, string> = {
  ok: "ok  ",
  fix: "FIX ",
  warn: "WARN",
  info: "info",
};

export function renderOnboardReport(report: OnboardReport): string {
  const lines: string[] = [];
  lines.push("VerifyFlow onboarding — guided first-run setup");
  lines.push("");
  for (const s of report.steps) {
    lines.push(`  [${ICON[s.status]}] ${s.name}: ${s.detail}`);
    for (const i of s.instructions) lines.push(`        ${i}`);
    if (s.instructions.length) lines.push("");
  }
  lines.push(
    report.ready
      ? "All required prerequisites are ready."
      : "Apply the FIX steps above, then re-run `vf doctor` to verify.",
  );
  lines.push("");
  lines.push("Smoke-test (offline, no credentials needed):");
  lines.push(`  ${report.smokeTest}`);
  return lines.join("\n");
}
