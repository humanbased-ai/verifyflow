/**
 * Detects output that means the PROBE or its environment is broken — not the product.
 *
 * A command that errors this way proves nothing about the PR: it must never be scored as a
 * product `fail` (verdict engine), and it is the signal to regenerate the probe before judging
 * (probe self-check, IN-552). Observed in dogfooding (IN-545): a malformed `uv run d=$(…)`
 * probe ran the system binary and produced "unrecognized arguments" / argparse usage dumps;
 * `python3 -m pytest` without the project env produced "No module named pytest".
 */
export const HARNESS_ERROR_SIGNATURES: RegExp[] = [
  /\bcommand not found\b/i,
  /\bno such file or directory\b/i,
  /\bfailed to spawn\b/i,
  /\bunrecognized arguments\b/i,
  /\bno module named\b/i,
  /\bmodulenotfounderror\b/i,
  /^usage:/im,
  /\berror: failed to\b/i,
];

export function looksLikeHarnessError(text: string): boolean {
  return HARNESS_ERROR_SIGNATURES.some((re) => re.test(text));
}
