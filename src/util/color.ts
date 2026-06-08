/**
 * Dependency-free ANSI color for human-facing terminal output (IN-748).
 *
 * VerifyFlow keeps zero runtime dependencies, so this is a tiny hand-rolled helper rather than
 * chalk/picocolors. It colors only the human-facing diagnostic/progress output (stderr + the
 * doctor/onboard reports) — never the machine-readable stdout (markdown/JSON reports), which
 * callers print without these helpers so piped/saved output stays clean.
 *
 * Color is enabled only when the output is an interactive terminal and the environment hasn't
 * opted out. Piped output is never a TTY, so it stays plain automatically. Tests that string-match
 * the rendered reports (doctor.test.ts, onboard.test.ts) disable color explicitly via
 * `refreshColor({ NO_COLOR: "1" })` — they must not rely on ambient TTY state, because the test
 * runner inherits the terminal's stdio and would otherwise see color when run interactively.
 */

const CODES = {
  reset: 0,
  bold: 1,
  dim: 2,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  cyan: 36,
} as const;

/**
 * Decide whether to emit ANSI codes. Precedence:
 *  1. `NO_COLOR` present (any value) → off (https://no-color.org).
 *  2. `FORCE_COLOR` present and not "0"/"false" → on (overrides the TTY check, e.g. for CI logs).
 *  3. `TERM=dumb` → off.
 *  4. otherwise: on iff BOTH stdout and stderr are TTYs.
 *
 * We require both because this helper colors output on *both* streams — doctor/onboard reports go
 * to stdout, while the criterion table, run progress, and watch lines go to stderr. Gating on a
 * single stream would either leak ANSI into a redirected file (`vf run 2> log`) or silently drop
 * color from the interactive stream when the other is piped (`vf run > report.md`). Requiring both
 * to be terminals means color appears only in fully-interactive use and never pollutes a redirect.
 */
function computeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if ("NO_COLOR" in env) return false;
  const force = env.FORCE_COLOR;
  if (force !== undefined && force !== "0" && force !== "false") return true;
  if (env.TERM === "dumb") return false;
  return Boolean(process.stdout.isTTY && process.stderr.isTTY);
}

/** Whether color is currently enabled. A live binding so `refreshColor` can flip it in tests. */
export let colorEnabled = computeEnabled();

/** Recompute the enablement from the (optionally injected) env. Returns the new value. */
export function refreshColor(env: NodeJS.ProcessEnv = process.env): boolean {
  colorEnabled = computeEnabled(env);
  return colorEnabled;
}

function wrap(code: number): (s: string) => string {
  return (s) => (colorEnabled ? `\x1b[${code}m${s}\x1b[${CODES.reset}m` : s);
}

export const red = wrap(CODES.red);
export const green = wrap(CODES.green);
export const yellow = wrap(CODES.yellow);
export const blue = wrap(CODES.blue);
export const cyan = wrap(CODES.cyan);
export const dim = wrap(CODES.dim);
export const bold = wrap(CODES.bold);

/**
 * Color a delivery verdict by severity, so a glance distinguishes accept (green) from a blocker
 * (red) from a soft outcome (yellow). Unknown strings pass through uncolored.
 */
export function colorizeVerdict(verdict: string): string {
  switch (verdict) {
    case "accept":
      return green(verdict);
    case "needs_fix":
    case "error":
      return red(verdict);
    case "manual_review_required":
    case "accept_with_risks":
      return yellow(verdict);
    default:
      return verdict;
  }
}
