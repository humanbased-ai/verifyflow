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
  /** Where the config came from, e.g. "file" | "inferred-python-uv" | "inferred-go" | "unknown". */
  source: string;
  /**
   * True when the repo ecosystem could not be determined and no explicit config was provided.
   * VerifyFlow must NOT guess a toolchain in this case — the run is reported as
   * environment-blocked rather than executed against wrong commands (IN-551).
   */
  unknown?: boolean;
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

/**
 * On-disk shape of `verifyflow.config.json` — the fields `readExplicit` reads. Shared with
 * `vf init`'s scaffold writer (cli/init.ts) so the writer and reader can never drift. All
 * fields optional; the loader fills sensible defaults.
 */
export interface VerifyflowFileConfig {
  /** Free-form note; ignored by the loader. */
  "//"?: string;
  setup?: string[];
  test?: string;
  runPrefix?: string;
  testGlobPrefix?: string;
}

export async function loadRepoConfig(workdir: string | undefined): Promise<RepoConfig> {
  if (workdir) {
    const explicit = await readExplicit(workdir);
    if (explicit) return explicit;
    const inferred = await infer(workdir);
    if (inferred) return inferred;
  }
  // No explicit config and no recognized ecosystem: do NOT guess a toolchain (IN-551).
  // Guessing python-uv here is exactly what produced wrong commands on non-uv repos.
  return {
    setup: [],
    test: "",
    testForFiles: () => undefined,
    source: "unknown",
    unknown: true,
  };
}

async function readExplicit(workdir: string): Promise<RepoConfig | undefined> {
  try {
    const raw = await fs.readFile(path.join(workdir, "verifyflow.config.json"), "utf8");
    const j = JSON.parse(raw) as VerifyflowFileConfig;
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

/**
 * Infer the toolchain from well-known files. Ordered most-specific first so a lockfile
 * (uv.lock, poetry.lock, pnpm-lock.yaml) wins over the generic manifest it sits next to.
 * Returns undefined when nothing matches — the caller then reports environment-unknown.
 */
async function infer(workdir: string): Promise<RepoConfig | undefined> {
  const has = async (f: string) =>
    fs.access(path.join(workdir, f)).then(() => true).catch(() => false);
  const readText = async (f: string) =>
    fs.readFile(path.join(workdir, f), "utf8").catch(() => "");

  const hasPyproject = await has("pyproject.toml");

  // --- Python -------------------------------------------------------------------------
  if (hasPyproject && (await has("uv.lock"))) return pythonUvConfig("inferred-python-uv");
  if ((await has("poetry.lock")) || /\[tool\.poetry\]/.test(await readText("pyproject.toml"))) {
    return prefixedPytest("poetry run", "inferred-python-poetry", ["poetry install"]);
  }
  if (hasPyproject || (await has("requirements.txt")) || (await has("setup.py")) || (await has("setup.cfg"))) {
    // Plain pip/venv: no reliable run prefix; use the interpreter directly.
    return prefixedPytest(undefined, "inferred-python-pip", [
      "python -m pip install -e . || python -m pip install -r requirements.txt || true",
    ]);
  }

  // --- Node ---------------------------------------------------------------------------
  if (await has("pnpm-lock.yaml")) return nodeConfig("pnpm", "inferred-node-pnpm");
  if (await has("yarn.lock")) return nodeConfig("yarn", "inferred-node-yarn");
  if (await has("package.json")) return nodeConfig("npm", "inferred-node");

  // --- Other ecosystems ---------------------------------------------------------------
  if (await has("go.mod")) {
    return {
      setup: ["go build ./..."],
      test: "go test ./...",
      testForFiles: (paths) => (paths.length ? `go test ${dirsOf(paths).join(" ")}` : "go test ./..."),
      source: "inferred-go",
    };
  }
  if (await has("Cargo.toml")) {
    return {
      setup: ["cargo build"],
      test: "cargo test",
      testForFiles: () => "cargo test",
      runPrefix: "cargo run --",
      source: "inferred-cargo",
    };
  }
  if (await has("Makefile")) {
    return {
      setup: ["make"],
      test: "make test",
      testForFiles: () => "make test",
      source: "inferred-make",
    };
  }
  return undefined;
}

/** Unique parent directories of the given file paths (for `go test <dir>`). */
function dirsOf(paths: string[]): string[] {
  const dirs = new Set(paths.map((p) => "./" + (path.posix.dirname(p) || ".")));
  return [...dirs];
}

function nodeConfig(pm: "npm" | "pnpm" | "yarn", source: string): RepoConfig {
  const install = pm === "npm" ? "npm ci || npm install" : pm === "pnpm" ? "pnpm install" : "yarn install";
  const runner = pm === "npm" ? "npx" : pm;
  return {
    setup: [install],
    test: `${pm === "yarn" ? "yarn" : pm} test`,
    testForFiles: (paths) => (paths.length ? `${runner} vitest run ${paths.join(" ")}` : undefined),
    source,
  };
}

/** A pytest-based Python config with an optional run prefix (uv run / poetry run / none). */
function prefixedPytest(runPrefix: string | undefined, source: string, setup: string[]): RepoConfig {
  const base = runPrefix ? `${runPrefix} pytest -q` : "python -m pytest -q";
  return {
    setup,
    test: base,
    runPrefix,
    testForFiles: (paths, keywords) =>
      paths.length ? `${base} ${paths.join(" ")}${kFilter(true, keywords)}` : undefined,
    source,
  };
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
