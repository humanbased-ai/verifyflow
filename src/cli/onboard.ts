import { runDoctor, type DoctorReport } from "./doctor.js";
import { run } from "../util/exec.js";
import { writeCredentials, getCredentialsPath, type Credentials } from "./credentials.js";

/**
 * `vf onboard` (#41): guided first-run setup. Doctor *diagnoses*; onboard *guides* — for each
 * missing prerequisite it prints the exact fix command for the user's platform (PowerShell on
 * Windows, POSIX shell elsewhere). When the user pastes a Linear API key, onboard persists it
 * to ~/.verifyflow/credentials.json (0600) so subsequent `vf run` invocations resolve it
 * automatically — no environment-variable juggling required.
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
  /** Detect current repo as "owner/repo". Defaults to running `gh repo view`. */
  detectRepo?: () => Promise<string | undefined>;
  /** Detect open PR number for the current branch. Defaults to running `gh pr view`. */
  detectPr?: () => Promise<number | undefined>;
  /** Persist credentials. Defaults to writing ~/.verifyflow/credentials.json. Injectable for tests. */
  saveCredentials?: (creds: Credentials) => Promise<string>;
}

async function defaultSaveCredentials(creds: Credentials): Promise<string> {
  const p = getCredentialsPath();
  await writeCredentials(creds, p);
  return p;
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

async function defaultDetectRepo(): Promise<string | undefined> {
  const r = await run("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
  const out = r.stdout.trim();
  return r.executed && r.code === 0 && out ? out : undefined;
}

async function defaultDetectPr(): Promise<number | undefined> {
  const r = await run("gh", ["pr", "view", "--json", "number", "-q", ".number"]);
  const n = parseInt(r.stdout.trim(), 10);
  return r.executed && r.code === 0 && !isNaN(n) ? n : undefined;
}

export async function runOnboard(deps: OnboardDeps = {}): Promise<OnboardReport> {
  const platform = deps.platform ?? process.platform;
  const doctor = deps.doctor ?? (() => runDoctor());
  const ghAuthed = deps.ghAuthed ?? defaultGhAuthed;
  const detectRepo = deps.detectRepo ?? defaultDetectRepo;
  const detectPr = deps.detectPr ?? defaultDetectPr;
  const saveCredentials = deps.saveCredentials ?? defaultSaveCredentials;
  const report = await doctor();
  const steps: OnboardStep[] = [];

  const findCheck = (predicate: (name: string) => boolean) =>
    report.checks.find((c) => predicate(c.name));

  // gh: doctor only knows whether the binary is on PATH. An installed-but-unauthenticated `gh` is
  // a distinct failure mode that doctor can't see — onboard probes it so the user gets the right
  // remediation (install vs login) instead of a misleading "gh: ok" followed by silent API 401s.
  const gh = findCheck((n) => n === "gh");
  let ghBinaryPresent = false;
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
    ghBinaryPresent = true;
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

  // repo detection: only run when gh binary is present. Surfaced as `info` (not a blocker) when
  // the repo cannot be detected — the user may simply not be inside a git checkout.
  let repo: string | undefined;
  let pr: number | undefined;
  if (ghBinaryPresent) {
    repo = await detectRepo();
    if (repo) pr = await detectPr();
    const repoStep: OnboardStep = repo
      ? { name: "repo", status: "ok", detail: `detected ${repo}`, instructions: [] }
      : {
          name: "repo",
          status: "info",
          detail: "could not detect repo from current directory",
          instructions: [],
        };
    steps.push(repoStep);
  }

  // LINEAR_API_KEY: the FAIL most newcomers hit. Interactive flow saves the pasted key to
  // ~/.verifyflow/credentials.json so vf can resolve it from then on — no shell-env juggling
  // needed. Non-interactive (or skipped) prints the placeholder env-setting commands so the
  // output still works in CI.
  const linear = findCheck((n) => n === "LINEAR_API_KEY");
  if (linear && !linear.ok) {
    let pasted: string | undefined;
    if (deps.prompt) {
      const answer = (
        await deps.prompt(
          "Paste your Linear API key to save it to ~/.verifyflow/credentials.json (or press Enter to skip): ",
        )
      ).trim();
      if (answer) pasted = answer;
    }

    if (pasted) {
      // Persist directly — child processes can't mutate the parent shell's env, but they CAN
      // own a config file. From now on `resolveLinearApiKey()` will find this key.
      let savedAt: string | undefined;
      let saveError: string | undefined;
      try {
        savedAt = await saveCredentials({ linearApiKey: pasted });
      } catch (e) {
        saveError = (e as Error).message;
      }
      if (savedAt) {
        steps.push({
          name: "LINEAR_API_KEY",
          status: "ok",
          detail: `saved to ${savedAt}`,
          instructions: [
            "VerifyFlow now resolves the key from this file (no shell env var needed).",
            "To override per-shell, you can still set LINEAR_API_KEY in your environment.",
          ],
        });
      } else {
        const lines: string[] = [
          `Could not write credentials file: ${saveError ?? "unknown error"}`,
          "Fallback — set the env var manually:",
          "",
          ...setEnvCommand(platform, "LINEAR_API_KEY", pasted),
        ];
        steps.push({ name: "LINEAR_API_KEY", status: "fix", detail: linear.detail, instructions: lines });
      }
    } else {
      const lines: string[] = [
        "Generate a personal API key in Linear: Settings → Account → Security & access → Personal API keys.",
        "Then re-run `vf onboard` and paste it when prompted — it will be saved to ~/.verifyflow/credentials.json.",
        "",
        "Or set the env var manually:",
        "",
        ...setEnvCommand(platform, "LINEAR_API_KEY", "<your-linear-api-key>"),
        "",
        "For offline runs you can skip this entirely and pass `--fixtures <dir>`.",
      ];
      steps.push({ name: "LINEAR_API_KEY", status: "fix", detail: linear.detail, instructions: lines });
    }
  } else if (linear) {
    steps.push({ name: "LINEAR_API_KEY", status: "ok", detail: linear.detail, instructions: [] });
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

  // Build dynamic smoke-test command based on what was detected.
  let smokeTest: string;
  if (repo && pr !== undefined) {
    smokeTest = `vf run --pr ${repo}#${pr} --level auto`;
  } else if (repo) {
    smokeTest = `vf run --pr ${repo}#<N> --level auto  # replace <N> with your PR number`;
  } else {
    smokeTest = "vf demo  # offline demo, no credentials needed";
  }

  const ready = steps.every((s) => s.status !== "fix");
  return { steps, ready, smokeTest };
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
  lines.push("Smoke-test:");
  lines.push(`  ${report.smokeTest}`);
  return lines.join("\n");
}
