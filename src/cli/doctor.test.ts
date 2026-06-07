/** IN-611: `vf doctor` reports tool/env readiness and fails only on missing REQUIRED items. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runDoctor, renderDoctorReport } from "./doctor.js";

const allPresent = async (_n: string) => true;
const nonePresent = async (_n: string) => false;

/** Default to "no credentials file" so tests don't accidentally pick up the developer's real key. */
const noFile = async (env: NodeJS.ProcessEnv) => env.LINEAR_API_KEY;

test("all tools present + key set → ok", async () => {
  const report = await runDoctor({
    env: { LINEAR_API_KEY: "x" },
    hasBin: allPresent,
    hasPlaywright: async () => true,
    resolveLinearKey: noFile,
  });
  assert.equal(report.ok, true);
  assert.ok(report.checks.every((c) => c.ok));
});

test("missing optional tools (claude/uv) still ok when required ones are present", async () => {
  const hasBin = async (n: string) => n === "gh"; // claude/uv missing
  const report = await runDoctor({ env: { LINEAR_API_KEY: "x" }, hasBin, resolveLinearKey: noFile });
  assert.equal(report.ok, true, "optional misses do not fail doctor");
  assert.equal(report.checks.find((c) => c.name === "claude")!.ok, false);
});

test("missing gh (required) → not ok", async () => {
  const hasBin = async (n: string) => n !== "gh";
  const report = await runDoctor({ env: { LINEAR_API_KEY: "x" }, hasBin, resolveLinearKey: noFile });
  assert.equal(report.ok, false);
});

test("missing LINEAR_API_KEY (required) → not ok", async () => {
  const report = await runDoctor({ env: {}, hasBin: allPresent, resolveLinearKey: noFile });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((c) => c.name === "LINEAR_API_KEY")!.ok, false);
});

test("credentials file fallback: env empty but file has key → ok", async () => {
  const report = await runDoctor({
    env: {},
    hasBin: allPresent,
    hasPlaywright: async () => true,
    resolveLinearKey: async () => "key-from-file",
  });
  const linear = report.checks.find((c) => c.name === "LINEAR_API_KEY")!;
  assert.equal(linear.ok, true);
  assert.match(linear.detail, /credentials file/);
});

test("env wins over credentials file source label", async () => {
  const report = await runDoctor({
    env: { LINEAR_API_KEY: "env-key" },
    hasBin: allPresent,
    hasPlaywright: async () => true,
    resolveLinearKey: async (e) => e.LINEAR_API_KEY ?? "file-key",
  });
  const linear = report.checks.find((c) => c.name === "LINEAR_API_KEY")!;
  assert.match(linear.detail, /\(env\)/);
});

test("render marks required misses FAIL and optional misses warn", async () => {
  const report = await runDoctor({
    env: {},
    hasBin: nonePresent,
    hasPlaywright: async () => false,
    resolveLinearKey: noFile,
  });
  const text = renderDoctorReport(report);
  assert.match(text, /\[FAIL\] gh/);
  assert.match(text, /\[WARN\] claude/);
  assert.match(text, /missing required tools/);
  assert.match(text, /vf onboard/, "doctor failure points users at the guided fix");
});

test("IN-625: reports sandbox (docker/podman) and playwright readiness lines", async () => {
  const report = await runDoctor({
    env: { LINEAR_API_KEY: "x" },
    hasBin: allPresent,
    hasPlaywright: async () => true,
    resolveLinearKey: noFile,
  });
  const sandbox = report.checks.find((c) => c.name.startsWith("sandbox"));
  const pw = report.checks.find((c) => c.name === "playwright");
  assert.ok(sandbox, "sandbox check present");
  assert.ok(pw, "playwright check present");
  assert.equal(sandbox!.ok, true);
  assert.equal(pw!.ok, true);
  assert.match(sandbox!.detail, /docker/);
});

test("IN-625: missing sandbox + playwright only WARN (optional), doctor still ok", async () => {
  // gh + LINEAR present, but no container runtime and no playwright.
  const hasBin = async (n: string) => n === "gh";
  const report = await runDoctor({
    env: { LINEAR_API_KEY: "x" },
    hasBin,
    hasPlaywright: async () => false,
    resolveLinearKey: noFile,
  });
  assert.equal(report.ok, true, "missing optional sandbox/playwright must not fail doctor");
  const text = renderDoctorReport(report);
  assert.match(text, /\[WARN\] sandbox/);
  assert.match(text, /\[WARN\] playwright/);
  assert.match(text, /neither docker nor podman/);
});

test("IN-625: podman alone satisfies the sandbox check", async () => {
  const hasBin = async (n: string) => n === "gh" || n === "podman";
  const report = await runDoctor({
    env: { LINEAR_API_KEY: "x" },
    hasBin,
    hasPlaywright: async () => false,
    resolveLinearKey: noFile,
  });
  const sandbox = report.checks.find((c) => c.name.startsWith("sandbox"))!;
  assert.equal(sandbox.ok, true);
  assert.match(sandbox.detail, /podman/);
});
