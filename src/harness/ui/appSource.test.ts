/**
 * IN-606 PR-1: app-source resolution for ui-level browser checks.
 * Deterministic decision core — explicit → preview → local-serve, blocking (never faking) when
 * no tier yields a live URL.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractPreviewUrl,
  inferServePlan,
  resolveAppSource,
  type DeploymentStatus,
} from "./appSource.js";
import type { RepoConfig } from "../../core/planner/repoConfig.js";
import type { PrContext } from "../../types.js";

const pr: PrContext = {
  repo: "acme/app",
  number: 7,
  url: "https://github.com/acme/app/pull/7",
  title: "add form",
  body: "",
  headRef: "feat/form",
  headSha: "deadbeef",
  baseRef: "main",
  additions: 1,
  deletions: 0,
  changedFiles: [],
  diff: "",
  source: "fixture",
};

const nodeCfg: RepoConfig = {
  setup: ["npm ci"],
  test: "npm test",
  testForFiles: () => undefined,
  source: "inferred-node",
};
const unknownCfg: RepoConfig = { setup: [], test: "", testForFiles: () => undefined, source: "unknown", unknown: true };
const goCfg: RepoConfig = { setup: [], test: "go test ./...", testForFiles: () => undefined, source: "inferred-go" };

// --- extractPreviewUrl -----------------------------------------------------------------------

test("extractPreviewUrl: picks the successful preview deployment", () => {
  const statuses: DeploymentStatus[] = [
    { state: "pending", targetUrl: "https://app-pending.vercel.app", context: "vercel" },
    { state: "success", targetUrl: "https://app-abc123.vercel.app", context: "Vercel – acme" },
  ];
  assert.equal(extractPreviewUrl(statuses), "https://app-abc123.vercel.app");
});

test("extractPreviewUrl: ignores failed/pending and non-preview success (e.g. CI)", () => {
  const statuses: DeploymentStatus[] = [
    { state: "failure", targetUrl: "https://app.vercel.app", context: "vercel" },
    { state: "success", targetUrl: "https://github.com/acme/app/runs/1", context: "ci/test" },
  ];
  assert.equal(extractPreviewUrl(statuses), undefined);
});

test("extractPreviewUrl: prefers a recognized preview host, then the newest", () => {
  const statuses: DeploymentStatus[] = [
    { state: "success", targetUrl: "https://internal.example.com/deploy", context: "deploy", createdAt: "2026-06-01T00:00:00Z" },
    { state: "success", targetUrl: "https://app-old.netlify.app", context: "netlify", createdAt: "2026-06-01T00:00:00Z" },
    { state: "success", targetUrl: "https://app-new.netlify.app", context: "netlify", createdAt: "2026-06-03T00:00:00Z" },
  ];
  assert.equal(extractPreviewUrl(statuses), "https://app-new.netlify.app");
});

test("extractPreviewUrl: trailing slash trimmed; empty list → undefined", () => {
  assert.equal(extractPreviewUrl([{ state: "success", targetUrl: "https://x.vercel.app/", context: "vercel" }]), "https://x.vercel.app");
  assert.equal(extractPreviewUrl([]), undefined);
});

// --- inferServePlan --------------------------------------------------------------------------

test("inferServePlan: node repo gets a pinned-port preview/dev plan", () => {
  const plan = inferServePlan(nodeCfg, 5000);
  assert.ok(plan);
  assert.equal(plan!.baseUrl, "http://localhost:5000");
  assert.match(plan!.command, /--port 5000/);
});

test("inferServePlan: unknown and non-node ecosystems yield no plan (caller blocks)", () => {
  assert.equal(inferServePlan(unknownCfg), undefined);
  assert.equal(inferServePlan(goCfg), undefined);
});

// --- resolveAppSource ------------------------------------------------------------------------

test("resolveAppSource: explicit base-url wins and is normalized", async () => {
  const r = await resolveAppSource({ explicitBaseUrl: "http://localhost:3000/", pr, repoConfig: nodeCfg });
  assert.equal(r.kind, "ready");
  if (r.kind === "ready") {
    assert.equal(r.source, "explicit");
    assert.equal(r.baseUrl, "http://localhost:3000");
  }
});

test("resolveAppSource: falls back to a discovered preview when no base-url", async () => {
  const r = await resolveAppSource({
    pr,
    repoConfig: nodeCfg,
    deps: { lookupDeployments: async () => [{ state: "success", targetUrl: "https://app.vercel.app", context: "vercel" }] },
  });
  assert.equal(r.kind, "ready");
  if (r.kind === "ready") {
    assert.equal(r.source, "preview");
    assert.equal(r.baseUrl, "https://app.vercel.app");
  }
});

test("resolveAppSource: falls back to local serve when wired and no preview", async () => {
  let cleaned = false;
  const r = await resolveAppSource({
    pr,
    repoConfig: nodeCfg,
    deps: {
      lookupDeployments: async () => [],
      startServer: async (plan) => ({ baseUrl: plan.baseUrl, cleanup: async () => { cleaned = true; } }),
    },
  });
  assert.equal(r.kind, "ready");
  if (r.kind === "ready") {
    assert.equal(r.source, "local-serve");
    await r.cleanup();
    assert.ok(cleaned, "cleanup tears down the started server");
  }
});

test("resolveAppSource: blocks (never fakes) when no tier yields a URL; reason lists what was tried", async () => {
  const r = await resolveAppSource({
    pr,
    repoConfig: unknownCfg,
    deps: { lookupDeployments: async () => [] },
  });
  assert.equal(r.kind, "blocked");
  if (r.kind === "blocked") {
    assert.match(r.reason, /no successful preview/);
    assert.match(r.reason, /no local serve plan/);
  }
});

test("resolveAppSource: a failing preview lookup is recorded, not thrown", async () => {
  const r = await resolveAppSource({
    pr,
    repoConfig: unknownCfg,
    deps: { lookupDeployments: async () => { throw new Error("gh boom"); } },
  });
  assert.equal(r.kind, "blocked");
  if (r.kind === "blocked") assert.match(r.reason, /preview lookup failed: gh boom/);
});
