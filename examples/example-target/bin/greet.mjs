#!/usr/bin/env node
// Minimal CLI used as a real execution target for VerifyFlow's e2e test.
// Delivers EX-1: `--version` prints `ExampleCLI <version>` (read from package.json) and exits 0.
import { readFileSync } from "node:fs";

function version() {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  return pkg.version; // read from package metadata — not hardcoded
}

const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-V")) {
  process.stdout.write(`ExampleCLI ${version()}\n`);
  process.exit(0);
}
process.stdout.write("usage: greet [--version]\n");
process.exit(0);
