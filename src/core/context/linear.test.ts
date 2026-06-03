import { test } from "node:test";
import assert from "node:assert/strict";
import { linearKeyFromPr } from "./linear.js";
import type { PrContext } from "../../types.js";

function pr(over: Partial<PrContext>): PrContext {
  return {
    repo: "example/greet",
    number: 7,
    url: "https://github.com/example/greet/pull/7",
    title: "t",
    body: "",
    headRef: "feat/no-key-here",
    headSha: "deadbeef",
    baseRef: "main",
    additions: 0,
    deletions: 0,
    changedFiles: [],
    diff: "",
    source: "test",
    ...over,
  };
}

test("linearKeyFromPr: explicit linear.app link in the body wins", () => {
  assert.equal(
    linearKeyFromPr(
      pr({ body: "## Linear\n\nhttps://linear.app/acme/issue/IN-318/title", headRef: "haol/in-999-x" }),
    ),
    "IN-318",
  );
});

test("linearKeyFromPr: bare key in the body beats the branch name", () => {
  assert.equal(linearKeyFromPr(pr({ body: "Fixes IN-545.", headRef: "haol/in-999-x" })), "IN-545");
});

test("linearKeyFromPr: falls back to the Linear branch format (IN-569)", () => {
  assert.equal(
    linearKeyFromPr(pr({ headRef: "haol/in-569-phase-1-usable-integration" })),
    "IN-569",
  );
  assert.equal(linearKeyFromPr(pr({ headRef: "in-12-short" })), "IN-12");
});

test("linearKeyFromPr: undefined when neither body nor branch carries a key", () => {
  assert.equal(linearKeyFromPr(pr({ headRef: "feature/just-a-slug" })), undefined);
});
