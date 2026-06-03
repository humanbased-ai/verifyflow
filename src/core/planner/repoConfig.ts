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
  /**
   * Build a scoped test command for specific changed test files, optionally narrowed to
   * keyword-matching tests (selective execution) when the runner supports it (e.g. pytest -k).
   */
  testForFiles: (paths: string[], keywords?: string[]) => string | undefined;
  /** Prefix used to run project entrypoints (e.g. "uv run"); undefined for none. */
  runPrefix?: string;
  /** Where the config came from: "file" | "inferred-python-uv" | "inferred-node" | "none". */
  source: string;
}

// Binaries that already resolve outside the project environment and must never be
// prefixed with runPrefix. Note: python/python3/pytest are intentionally NOT here — in a
// uv/poetry project they must run inside the project env (`uv run pytest`), or they pick up
// the system interpreter and report a false failure (e.g. "No module named pytest").
const SYSTEM_BINS = new Set([
  "sh", "bash", "env", "curl", "git", "echo", "cat", "ls", "grep",
  "node", "uv", "npm", "pnpm", "yarn", "go", "cargo", "make",
]);

/** Shell metacharacters that make a command "compound" (more than one simple invocation). */
const COMPOUND = /[;&|]|\$\(|`|\n|(^|\s)[A-Za-z_][A-Za-z0-9_]*=/;

/** Single-quote a string for safe embedding inside a POSIX `sh -c '...'` wrapper. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Adapt a probe command so every project entrypoint inside it runs in the repo environment.
 *
 * The naive "prefix the first token" approach breaks on two real failure modes observed in
 * dogfooding (IN-545): a compound command like `d=$(mktemp -d); symphony info "$d/..."`
 * would get `runPrefix` glued onto the leading `d=` assignment (so the prefix runs a bogus
 * program AND the real `symphony` call runs unprefixed against the system binary), and
 * `python3 -m pytest` would be left unprefixed and miss the project's pytest.
 *
 * Fix: a compound command is wrapped whole — `<runPrefix> sh -c '<command>'` — so the
 * project environment is active for *all* sub-commands, including assignments, pipes, and
 * interpreters. A simple single command keeps the lightweight token prefix.
 */
export function adaptCommand(command: string, cfg: RepoConfig): string {
  if (!cfg.runPrefix) return command;
  const trimmed = command.trim();

  if (COMPOUND.test(trimmed)) {
    // Wrap the whole thing so symphony/python/pytest inside all resolve to the project env.
    return `${cfg.runPrefix} sh -c ${shQuote(trimmed)}`;
  }

  const first = trimmed.split(/\s+/)[0] ?? "";
  if (SYSTEM_BINS.has(first)) return command;
  if (trimmed.startsWith(cfg.runPrefix)) return command;
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
    const isPytest = /pytest/.test(testGlobPrefix);
    return {
      setup: j.setup ?? [],
      test: j.test ?? "uv run pytest",
      runPrefix: j.runPrefix,
      testForFiles: (paths, keywords) =>
        paths.length
          ? `${testGlobPrefix} ${paths.join(" ")}${kFilter(isPytest, keywords)}`
          : undefined,
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
    testForFiles: (paths, keywords) =>
      paths.length ? `uv run pytest -q ${paths.join(" ")}${kFilter(true, keywords)}` : undefined,
    source,
  };
}

/** Build a pytest `-k` selector from keywords (selective execution); empty when unsupported. */
function kFilter(isPytest: boolean, keywords?: string[]): string {
  if (!isPytest || !keywords || keywords.length === 0) return "";
  return ` -k "${keywords.join(" or ")}"`;
}
