import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

/**
 * Local credentials store at ~/.verifyflow/credentials.json. Pasted via `vf onboard` so the
 * Linear API key survives across shell sessions without the user having to wrangle environment
 * variables — same shape as `gh`/`aws cli` config. Env var still wins; the file is a fallback.
 *
 * POSIX permissions are forced to 0600 (owner-only). Windows ACLs are left to the user — chmod
 * is largely a no-op there.
 */

export interface Credentials {
  linearApiKey?: string;
}

export function getCredentialsPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".verifyflow", "credentials.json");
}

export async function readCredentials(filePath: string = getCredentialsPath()): Promise<Credentials> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Credentials;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeCredentials(
  creds: Credentials,
  filePath: string = getCredentialsPath(),
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(creds, null, 2) + "\n", "utf8");
  if (process.platform !== "win32") {
    try {
      await fs.chmod(filePath, 0o600);
    } catch {
      /* best-effort — some filesystems (e.g. mounted FAT) reject chmod */
    }
  }
}

/**
 * Resolve the Linear API key from environment first, then the credentials file. Returns
 * `undefined` when neither source has it.
 */
export async function resolveLinearApiKey(
  env: NodeJS.ProcessEnv = process.env,
  filePath: string = getCredentialsPath(),
): Promise<string | undefined> {
  if (env.LINEAR_API_KEY) return env.LINEAR_API_KEY;
  const creds = await readCredentials(filePath);
  return creds.linearApiKey || undefined;
}
