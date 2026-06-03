/**
 * Sandbox policy for executing untrusted PR code (IN-555, first increment).
 *
 * Full isolation (container, scoped filesystem, network egress control) is a follow-up that
 * needs a container runtime. This slice closes the most dangerous hole that needs no runtime:
 * VerifyFlow runs with the operator's authorized CLIs, so the host environment carries live
 * secrets (LINEAR_API_KEY, GITHUB_TOKEN, gh/AWS credentials, …). By default we strip those from
 * the environment handed to probe/setup/test commands, so untrusted code cannot read them.
 *
 * `--no-sandbox` disables this for trusted local dogfooding.
 */

/** Env var names that look like secrets and must never reach untrusted probe code. */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|SESSION|COOKIE|_AUTH|AUTH_)/i;

/** Known credential-bearing prefixes to drop even when the name doesn't match SECRET_NAME. */
const SECRET_PREFIX = [
  "AWS_", "GOOGLE_", "GCP_", "AZURE_", "GH_", "GITHUB_", "NPM_", "PYPI_", "DOCKER_",
  "SLACK_", "STRIPE_", "OPENAI_", "ANTHROPIC_", "LINEAR_", "VERCEL_", "SUPABASE_",
];

function isSecret(name: string): boolean {
  if (SECRET_NAME.test(name)) return true;
  return SECRET_PREFIX.some((p) => name.startsWith(p));
}

/**
 * Return the environment a sandboxed command should see. When `isolate` is true (the default),
 * secret-looking variables are dropped; everything else (PATH, HOME, toolchain dirs) is kept so
 * setup/test/probe commands still work. When false, the full environment is passed through.
 */
export function sanitizeEnv(
  env: NodeJS.ProcessEnv,
  isolate: boolean,
): NodeJS.ProcessEnv {
  if (!isolate) return env;
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (!isSecret(k)) out[k] = v;
  }
  return out;
}
