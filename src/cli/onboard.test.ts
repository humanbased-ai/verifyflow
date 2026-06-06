/** #41: `vf onboard` produces a guided fix list with platform-aware commands. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runOnboard, renderOnboardReport } from "./onboard.js";
import type { DoctorReport } from "./doctor.js";

/** A doctor report fixture where every check reports `ok` if true, FAIL/WARN with given detail otherwise. */
function fakeDoctor(opts: {
  gh?: boolean;
  linear?: boolean;
  claude?: boolean;
  uv?: boolean;
  sandbox?: boolean;
  playwright?: boolean;
}): () => Promise<DoctorReport> {
  const v = {
    gh: opts.gh ?? true,
    linear: opts.linear ?? true,
    claude: opts.claude ?? true,
    uv: opts.uv ?? true,
    sandbox: opts.sandbox ?? true,
    playwright: opts.playwright ?? true,
  };
  return async () => ({
    ok: v.gh && v.linear,
    checks: [
      { name: "gh", ok: v.gh, required: true, detail: v.gh ? "found" : "not found on PATH" },
      {
        name: "LINEAR_API_KEY",
        ok: v.linear,
        required: true,
        detail: v.linear ? "set" : "not set — needed for live Linear issue access",
      },
      { name: "claude", ok: v.claude, required: false, detail: v.claude ? "found" : "not found" },
      { name: "uv", ok: v.uv, required: false, detail: v.uv ? "found" : "not found" },
      {
        name: "sandbox (docker/podman)",
        ok: v.sandbox,
        required: false,
        detail: v.sandbox ? "found (docker)" : "neither docker nor podman found",
      },
      {
        name: "playwright",
        ok: v.playwright,
        required: false,
        detail: v.playwright ? "installed" : "not installed",
      },
    ],
  });
}

test("everything green → ready, no FIX steps", async () => {
  const report = await runOnboard({ doctor: fakeDoctor({}), ghAuthed: async () => true });
  assert.equal(report.ready, true);
  assert.ok(report.steps.every((s) => s.status !== "fix"));
});

test("missing LINEAR_API_KEY (POSIX) emits an export line", async () => {
  const report = await runOnboard({
    doctor: fakeDoctor({ linear: false }),
    ghAuthed: async () => true,
    platform: "linux",
  });
  assert.equal(report.ready, false);
  const linear = report.steps.find((s) => s.name === "LINEAR_API_KEY")!;
  assert.equal(linear.status, "fix");
  const joined = linear.instructions.join("\n");
  assert.match(joined, /export LINEAR_API_KEY="<your-linear-api-key>"/);
  assert.doesNotMatch(joined, /SetEnvironmentVariable/);
});

test("missing LINEAR_API_KEY (Windows) emits both session + persistent PowerShell commands", async () => {
  const report = await runOnboard({
    doctor: fakeDoctor({ linear: false }),
    ghAuthed: async () => true,
    platform: "win32",
  });
  const linear = report.steps.find((s) => s.name === "LINEAR_API_KEY")!;
  const joined = linear.instructions.join("\n");
  assert.match(joined, /\$env:LINEAR_API_KEY = "<your-linear-api-key>"/);
  assert.match(joined, /SetEnvironmentVariable\("LINEAR_API_KEY", "<your-linear-api-key>", "User"\)/);
});

test("interactive: pasted key is inlined into the export command (and not lost as a placeholder)", async () => {
  const pasted = "lin_api_PASTED_VALUE_xyz";
  const report = await runOnboard({
    doctor: fakeDoctor({ linear: false }),
    ghAuthed: async () => true,
    platform: "linux",
    prompt: async () => pasted,
  });
  const linear = report.steps.find((s) => s.name === "LINEAR_API_KEY")!;
  const joined = linear.instructions.join("\n");
  assert.match(joined, new RegExp(`export LINEAR_API_KEY="${pasted}"`));
  assert.doesNotMatch(joined, /<your-linear-api-key>/);
});

test("interactive but user skips: falls back to placeholder, never blocks", async () => {
  const report = await runOnboard({
    doctor: fakeDoctor({ linear: false }),
    ghAuthed: async () => true,
    platform: "linux",
    prompt: async () => "   ", // whitespace only
  });
  const linear = report.steps.find((s) => s.name === "LINEAR_API_KEY")!;
  assert.match(linear.instructions.join("\n"), /<your-linear-api-key>/);
});

test("gh installed but not authenticated → FIX with `gh auth login`", async () => {
  const report = await runOnboard({ doctor: fakeDoctor({}), ghAuthed: async () => false });
  assert.equal(report.ready, false);
  const gh = report.steps.find((s) => s.name === "gh")!;
  assert.equal(gh.status, "fix");
  assert.match(gh.detail, /not authenticated/);
  assert.match(gh.instructions.join("\n"), /gh auth login/);
});

test("gh binary missing → FIX with install + auth instructions (no auth probe needed)", async () => {
  let ghProbeCalled = false;
  const report = await runOnboard({
    doctor: fakeDoctor({ gh: false }),
    ghAuthed: async () => {
      ghProbeCalled = true;
      return true;
    },
  });
  const gh = report.steps.find((s) => s.name === "gh")!;
  assert.equal(gh.status, "fix");
  assert.match(gh.instructions.join("\n"), /cli\.github\.com/);
  assert.equal(ghProbeCalled, false, "do not probe gh auth when gh isn't even installed");
});

test("claude missing only WARNs (not a FIX) → still ready", async () => {
  const report = await runOnboard({
    doctor: fakeDoctor({ claude: false }),
    ghAuthed: async () => true,
  });
  assert.equal(report.ready, true, "missing claude must not block readiness");
  const claude = report.steps.find((s) => s.name === "claude")!;
  assert.equal(claude.status, "warn");
});

test("playwright/uv/sandbox missing surface as `info` (not `warn`) — avoids alarming the user", async () => {
  const report = await runOnboard({
    doctor: fakeDoctor({ playwright: false, uv: false, sandbox: false }),
    ghAuthed: async () => true,
  });
  assert.equal(report.ready, true);
  for (const name of ["playwright", "uv", "sandbox"]) {
    const s = report.steps.find((x) => x.name === name)!;
    assert.equal(s.status, "info", `${name} should be info`);
  }
});

test("render output: FIX markers + smoke-test line + reverify hint when not ready", async () => {
  const report = await runOnboard({
    doctor: fakeDoctor({ linear: false }),
    ghAuthed: async () => true,
    platform: "linux",
  });
  const text = renderOnboardReport(report);
  assert.match(text, /\[FIX \] LINEAR_API_KEY/);
  assert.match(text, /Apply the FIX steps above, then re-run `vf doctor`/);
  assert.match(text, /fixtures\/example-cli/);
});

test("render output: ready state announces all required prerequisites are ready", async () => {
  const report = await runOnboard({ doctor: fakeDoctor({}), ghAuthed: async () => true });
  const text = renderOnboardReport(report);
  assert.match(text, /All required prerequisites are ready\./);
});
