import { test } from "node:test";
import assert from "node:assert/strict";
import { selectLevel, type AutoLevelEnv } from "./selectLevel.js";
import type { CriteriaModel, CriterionMethod, PrContext } from "../../types.js";

function pr(files: string[] = []): PrContext {
  return {
    repo: "o/r",
    number: 1,
    url: "https://github.com/o/r/pull/1",
    title: "t",
    body: "b",
    headRef: "h",
    headSha: "sha",
    baseRef: "main",
    additions: 0,
    deletions: 0,
    changedFiles: files.map((p) => ({ path: p })),
    diff: "",
    source: "fixture",
  };
}

function crit(method: CriterionMethod, text = "the command does a thing"): CriteriaModel {
  return {
    criteria: [{ id: "AC-1", text, source: "linear_explicit", method, observable: true }],
    ticketQualityIssues: [],
  };
}

const ready: AutoLevelEnv = { appAvailable: true, playwrightAvailable: true };
const bare: AutoLevelEnv = { appAvailable: false, playwrightAvailable: false };

test("backend criterion → functional", () => {
  const s = selectLevel(crit("backend"), pr(), bare);
  assert.equal(s.level, "functional");
  assert.equal(s.needed, "functional");
});

test("ui criterion with env ready → ui", () => {
  const s = selectLevel(crit("ui", "click the Greet button"), pr(), ready);
  assert.equal(s.needed, "ui");
  assert.equal(s.level, "ui");
});

test("integration criterion maps to ui", () => {
  const s = selectLevel(crit("integration"), pr(), ready);
  assert.equal(s.needed, "ui");
});

test("ui needed but env missing → downgrade to functional, with an explanatory note", () => {
  const s = selectLevel(crit("ui"), pr(), bare);
  assert.equal(s.needed, "ui");
  assert.equal(s.level, "functional");
  assert.ok(s.notes.some((n) => n.includes("downgraded")));
});

test("journey method with env ready → journey", () => {
  const s = selectLevel(crit("journey"), pr(), ready);
  assert.equal(s.level, "journey");
});

test("high-risk hints (no journey method) → journey", () => {
  const s = selectLevel(crit("backend", "charge the customer on checkout"), pr(["src/billing.ts"]), ready);
  assert.equal(s.needed, "journey");
});

test("UI hints in text (no ui method) → ui", () => {
  const s = selectLevel(crit("backend", "the page displays a success toast"), pr(), ready);
  assert.equal(s.needed, "ui");
});

test("unobservable criteria are ignored when picking the level", () => {
  const model: CriteriaModel = {
    criteria: [{ id: "AC-1", text: "click button", source: "linear_explicit", method: "ui", observable: false }],
    ticketQualityIssues: [],
  };
  const s = selectLevel(model, pr(), ready);
  assert.equal(s.needed, "functional");
});
