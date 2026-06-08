/** IN-737: `--version` / `-v` prints `verifyflow <version>` from package.json and exits 0. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

async function cli(...args: string[]): Promise<{ stdout: string; code: number }> {
  try {
    // Match scripts/run-tests.mjs: `node --import tsx` avoids the tsx CLI's IPC server.
    const { stdout } = await run(process.execPath, ["--import", "tsx", "src/cli/main.ts", ...args], {
      cwd: process.cwd(),
    });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; code?: number };
    return { stdout: e.stdout ?? "", code: typeof e.code === "number" ? e.code : 1 };
  }
}

test("`--version` prints `verifyflow <semver>` and exits 0", async () => {
  const { stdout, code } = await cli("--version");
  assert.equal(code, 0);
  assert.match(stdout, /^verifyflow \d+\.\d+\.\d+/m);
});

test("`-v` short flag behaves the same as `--version`", async () => {
  const { stdout, code } = await cli("-v");
  assert.equal(code, 0);
  assert.match(stdout, /^verifyflow \d+\.\d+\.\d+/m);
});

test("`--version` is listed in the help text so users can discover it", async () => {
  const { stdout } = await cli("--help");
  assert.match(stdout, /--version/);
});
