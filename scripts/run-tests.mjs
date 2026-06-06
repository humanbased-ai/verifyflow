import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function collectTests(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const tests = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      tests.push(...collectTests(path));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      tests.push(path);
    }
  }

  return tests.sort();
}

const testFiles = collectTests("src");

if (testFiles.length === 0) {
  console.error("No test files found under src.");
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...testFiles],
  { stdio: "inherit" },
);

process.exit(result.status ?? 1);
