import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * How VerifyFlow starts and tests a target repo. Declared by the repo in
 * `verifyflow.config.json`, or inferred from well-known files. VerifyFlow does not guess
 * commands silently — the resolved config is recorded in the report.
 */
export interface RepoConfig {
  setup: string[];
  /** Base test command (used when no changed test files can be scoped). */
  test: string;
  /** Build a scoped test command for specific changed test files. */
  testForFiles: (paths: string[]) => string | undefined;
  /** Prefix used to run project entrypoints (e.g. "uv run"); undefined for none. */
  runPrefix?: string;
  /** Where the config came from: "file" | "inferred-python-uv" | "inferred-node" | "none". */
  source: string;
}

const SYSTEM_BINS = new Set([
  "sh", "bash", "env", "curl", "git", "echo", "cat", "ls", "grep",
  "python", "python3", "node", "uv", "npm", "pnpm", "yarn", "pytest", "go", "cargo", "make",
]);

/** Adapt a probe command to the repo by prefixing project entrypoints with runPrefix. */
export function adaptCommand(command: string, cfg: RepoConfig): string {
  if (!cfg.runPrefix) return command;
  const first = command.trim().split(/\s+/)[0] ?? "";
  if (SYSTEM_BINS.has(first)) return command;
  if (command.startsWith(cfg.runPrefix)) return command;
  return `${cfg.runPrefix} ${command}`;
}

export async function loadRepoConfig(workdir: string | undefined): Promise<RepoConfig> {
  if (workdir) {
    const explicit = await readExplicit(workdir);
    if (explicit) return explicit;
    const inferred = await infer(workdir);
    if (inferred) return inferred;
  }
  // Default assumes a uv/pytest project (the dogfood target, Symphony).
  return pythonUvConfig("none");
}

async function readExplicit(workdir: string): Promise<RepoConfig | undefined> {
  try {
    const raw = await fs.readFile(path.join(workdir, "verifyflow.config.json"), "utf8");
    const j = JSON.parse(raw) as {
      setup?: string[]; test?: string; runPrefix?: string; testGlobPrefix?: string;
    };
    const testGlobPrefix = j.testGlobPrefix ?? j.test ?? "uv run pytest";
    return {
      setup: j.setup ?? [],
      test: j.test ?? "uv run pytest",
      runPrefix: j.runPrefix,
      testForFiles: (paths) =>
        paths.length ? `${testGlobPrefix} ${paths.join(" ")}` : undefined,
      source: "file",
    };
  } catch {
    return undefined;
  }
}

async function infer(workdir: string): Promise<RepoConfig | undefined> {
  const has = async (f: string) =>
    fs.access(path.join(workdir, f)).then(() => true).catch(() => false);
  if ((await has("pyproject.toml")) && (await has("uv.lock"))) {
    return pythonUvConfig("inferred-python-uv");
  }
  if (await has("package.json")) {
    return {
      setup: ["npm ci || npm install"],
      test: "npm test",
      testForFiles: (paths) =>
        paths.length ? `npx vitest run ${paths.join(" ")}` : undefined,
      source: "inferred-node",
    };
  }
  return undefined;
}

function pythonUvConfig(source: string): RepoConfig {
  return {
    setup: ["uv sync --frozen || uv sync"],
    test: "uv run pytest -q",
    runPrefix: "uv run",
    testForFiles: (paths) =>
      paths.length ? `uv run pytest -q ${paths.join(" ")}` : undefined,
    source,
  };
}
