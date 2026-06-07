/** IN-611: `--help` / `-h` as the first token prints usage (listing init/doctor) and exits 0. */
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

test("`--help` as the first token → usage listing init/doctor, exit 0", async () => {
  const { stdout, code } = await cli("--help");
  assert.equal(code, 0);
  assert.match(stdout, /vf init/);
  assert.match(stdout, /vf doctor/);
});

test("`help` subcommand also prints usage, exit 0", async () => {
  const { stdout, code } = await cli("help");
  assert.equal(code, 0);
  assert.match(stdout, /Usage:/);
});
