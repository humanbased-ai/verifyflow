/** #41: `vf onboard` produces a guided fix list with platform-aware commands. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runOnboard, renderOnboardReport } from "./onboard.js";
import type { DoctorReport } from "./doctor.js";
import { refreshColor } from "../util/color.js";

// Disable color: these tests string-match the rendered badges (e.g. `[FIX ] LINEAR_API_KEY`), and
// the test runner inherits the terminal's stdio, so color must not be left to ambient TTY state.
refreshColor({ NO_COLOR: "1" });

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

/** No-op detection helpers to prevent shell calls in tests that don't exercise detection. */
const noDetect = {
  detectRepo: async () => undefined as string | undefined,
  detectPr: async () => undefined as number | undefined,
};

test("everything green → ready, no FIX steps", async () => {
  const report = await runOnboard({ doctor: fakeDoctor({}), ghAuthed: async () => true, ...noDetect });
  assert.equal(report.ready, true);
  assert.ok(report.steps.every((s) => s.status !== "fix"));
});

test("missing LINEAR_API_KEY (POSIX) emits an export line", async () => {
  const report = await runOnboard({
    doctor: fakeDoctor({ linear: false }),
    ghAuthed: async () => true,
    platform: "linux",
    ...noDetect,
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
    ...noDetect,
  });
  const linear = report.steps.find((s) => s.name === "LINEAR_API_KEY")!;
  const joined = linear.instructions.join("\n");
  assert.match(joined, /\$env:LINEAR_API_KEY = "<your-linear-api-key>"/);
  assert.match(joined, /SetEnvironmentVariable\("LINEAR_API_KEY", "<your-linear-api-key>", "User"\)/);
});

test("interactive: pasted key is saved to credentials file (not just printed)", async () => {
  const pasted = "lin_api_PASTED_VALUE_xyz";
  let savedCreds: { linearApiKey?: string } | undefined;
  const report = await runOnboard({
    doctor: fakeDoctor({ linear: false }),
    ghAuthed: async () => true,
    platform: "linux",
    prompt: async () => pasted,
    saveCredentials: async (creds) => {
      savedCreds = creds;
      return "/fake/home/.verifyflow/credentials.json";
    },
    ...noDetect,
  });
  const linear = report.steps.find((s) => s.name === "LINEAR_API_KEY")!;
  assert.equal(linear.status, "ok", "credentials saved → step is ok, not fix");
  assert.equal(savedCreds?.linearApiKey, pasted);
  assert.match(linear.detail, /saved to .*credentials\.json/);
  // The pasted key itself MUST NOT appear in printed instructions — only the path does.
  const joined = linear.instructions.join("\n");
  assert.doesNotMatch(joined, new RegExp(pasted));
  // Onboard ready when save succeeds (no remaining FIX steps).
  assert.equal(report.ready, true);
});

test("interactive but user skips: falls back to placeholder env command, never blocks", async () => {
  let saveCalled = false;
  const report = await runOnboard({
    doctor: fakeDoctor({ linear: false }),
    ghAuthed: async () => true,
    platform: "linux",
    prompt: async () => "   ", // whitespace only
    saveCredentials: async () => {
      saveCalled = true;
      return "/should-not-be-called";
    },
    ...noDetect,
  });
  const linear = report.steps.find((s) => s.name === "LINEAR_API_KEY")!;
  assert.equal(linear.status, "fix");
  assert.match(linear.instructions.join("\n"), /<your-linear-api-key>/);
  assert.equal(saveCalled, false, "credentials must not be saved when user skips");
});

test("interactive: save failure falls back to printing env command, still reachable", async () => {
  const pasted = "lin_api_PASTED";
  const report = await runOnboard({
    doctor: fakeDoctor({ linear: false }),
    ghAuthed: async () => true,
    platform: "linux",
    prompt: async () => pasted,
    saveCredentials: async () => {
      throw new Error("EACCES: permission denied");
    },
    ...noDetect,
  });
  const linear = report.steps.find((s) => s.name === "LINEAR_API_KEY")!;
  assert.equal(linear.status, "fix");
  const joined = linear.instructions.join("\n");
  assert.match(joined, /Could not write credentials file/);
  assert.match(joined, new RegExp(`export LINEAR_API_KEY="${pasted}"`));
});

test("gh installed but not authenticated → FIX with `gh auth login`", async () => {
  const report = await runOnboard({ doctor: fakeDoctor({}), ghAuthed: async () => false, ...noDetect });
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
    ...noDetect,
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
    ...noDetect,
  });
  assert.equal(report.ready, true, "missing claude must not block readiness");
  const claude = report.steps.find((s) => s.name === "claude")!;
  assert.equal(claude.status, "warn");
});

test("playwright/uv/sandbox missing surface as `info` (not `warn`) — avoids alarming the user", async () => {
  const report = await runOnboard({
    doctor: fakeDoctor({ playwright: false, uv: false, sandbox: false }),
    ghAuthed: async () => true,
    ...noDetect,
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
    ...noDetect,
  });
  const text = renderOnboardReport(report);
  assert.match(text, /\[FIX \] LINEAR_API_KEY/);
  assert.match(text, /Apply the FIX steps above, then re-run `vf doctor`/);
  assert.match(text, /vf demo/);
});

test("render output: ready state announces all required prerequisites are ready", async () => {
  const report = await runOnboard({ doctor: fakeDoctor({}), ghAuthed: async () => true, ...noDetect });
  const text = renderOnboardReport(report);
  assert.match(text, /All required prerequisites are ready\./);
});

// --- repo/PR detection tests ---

test("detectRepo + detectPr both resolve → smoke test uses real repo#PR", async () => {
  const report = await runOnboard({
    doctor: fakeDoctor({}),
    ghAuthed: async () => true,
    detectRepo: async () => "owner/repo",
    detectPr: async () => 7,
  });
  assert.equal(report.smokeTest, "vf run --pr owner/repo#7 --level auto");
  const repoStep = report.steps.find((s) => s.name === "repo")!;
  assert.equal(repoStep.status, "ok");
  assert.match(repoStep.detail, /owner\/repo/);
});

test("detectRepo resolves but detectPr returns undefined → smoke test has #<N> placeholder", async () => {
  const report = await runOnboard({
    doctor: fakeDoctor({}),
    ghAuthed: async () => true,
    detectRepo: async () => "owner/repo",
    detectPr: async () => undefined,
  });
  assert.match(report.smokeTest, /vf run --pr owner\/repo#<N> --level auto/);
  assert.match(report.smokeTest, /replace <N> with your PR number/);
});

test("both detectRepo and detectPr return undefined → smoke test uses vf demo", async () => {
  const report = await runOnboard({
    doctor: fakeDoctor({}),
    ghAuthed: async () => true,
    detectRepo: async () => undefined,
    detectPr: async () => undefined,
  });
  assert.equal(report.smokeTest, "vf demo  # offline demo, no credentials needed");
  const repoStep = report.steps.find((s) => s.name === "repo")!;
  assert.equal(repoStep.status, "info");
});

test("gh binary missing → detectRepo/detectPr not called, smoke test uses vf demo", async () => {
  let detectRepoCalled = false;
  let detectPrCalled = false;
  const report = await runOnboard({
    doctor: fakeDoctor({ gh: false }),
    ghAuthed: async () => true,
    detectRepo: async () => { detectRepoCalled = true; return "owner/repo"; },
    detectPr: async () => { detectPrCalled = true; return 1; },
  });
  assert.equal(detectRepoCalled, false, "detectRepo must not be called when gh binary is missing");
  assert.equal(detectPrCalled, false, "detectPr must not be called when gh binary is missing");
  assert.equal(report.smokeTest, "vf demo  # offline demo, no credentials needed");
});

test("repo step comes immediately after gh step in steps array", async () => {
  const report = await runOnboard({
    doctor: fakeDoctor({}),
    ghAuthed: async () => true,
    detectRepo: async () => "owner/repo",
    detectPr: async () => 42,
  });
  const ghIdx = report.steps.findIndex((s) => s.name === "gh");
  const repoIdx = report.steps.findIndex((s) => s.name === "repo");
  assert.ok(ghIdx >= 0, "gh step must exist");
  assert.ok(repoIdx >= 0, "repo step must exist");
  assert.equal(repoIdx, ghIdx + 1, "repo step must come directly after gh step");
});
