/** IN-622: vf watch decision core — Crosscheck-approve detection + per-head dedup gate. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCrosscheckApprove, watchTick, type WatchDeps, type PrSummary } from "./watch.js";

// --- parseCrosscheckApprove -------------------------------------------------

test("detects the beta.6 badge APPROVE", () => {
  assert.equal(parseCrosscheckApprove([{ body: "### Code Review by 🤖 Claude Code\n\n✅ **APPROVE**\n\nLooks good." }]), true);
});

test("detects the legacy marker + VERDICT line", () => {
  assert.equal(parseCrosscheckApprove([{ body: "[crosscheck] review\n\nVERDICT: APPROVE" }]), true);
});

test("NEEDS WORK / request changes / block are not approve", () => {
  assert.equal(parseCrosscheckApprove([{ body: "### Code Review by Claude\n\n⚠️ **NEEDS WORK**" }]), false);
  assert.equal(parseCrosscheckApprove([{ body: "[crosscheck]\nVERDICT: BLOCK" }]), false);
});

test("newest Crosscheck comment wins; non-crosscheck comments ignored", () => {
  const comments = [
    { body: "### Code Review by Claude\n\n⚠️ **NEEDS WORK**" },
    { body: "some human comment about approve" }, // not a crosscheck comment
    { body: "### Code Review by Claude\n\n✅ **APPROVE**" }, // latest crosscheck → wins
  ];
  assert.equal(parseCrosscheckApprove(comments), true);
});

test("no crosscheck comment → not approved", () => {
  assert.equal(parseCrosscheckApprove([{ body: "LGTM 👍" }]), false);
  assert.equal(parseCrosscheckApprove([]), false);
});

test("a Crosscheck comment that merely contains the word 'approve' is NOT an approve (review fix)", () => {
  const body = "### Code Review by Claude\n\nI cannot approve this yet — it needs approval from a second reviewer.";
  assert.equal(parseCrosscheckApprove([{ body }]), false);
});

test("another bot's non-heading 'code review by' is not treated as Crosscheck (review fix)", () => {
  // Has the APPROVE badge but is not a `### Code Review by` heading → not a Crosscheck comment.
  assert.equal(parseCrosscheckApprove([{ body: "CodeRabbit code review by bot — ✅ **APPROVE**" }]), false);
});

// --- watchTick --------------------------------------------------------------

function deps(over: Partial<WatchDeps>): WatchDeps {
  return {
    listOpenPrs: async () => [],
    listIssueComments: async () => [],
    verify: async () => ({ verdict: "accept", merged: true }),
    ...over,
  };
}
const APPROVE = [{ body: "### Code Review by Claude\n\n✅ **APPROVE**" }];

test("verifies an approved PR once, then dedups the same head", async () => {
  const verified: number[] = [];
  const d = deps({
    listOpenPrs: async () => [{ number: 7, headSha: "aaa" }],
    listIssueComments: async () => APPROVE,
    verify: async (pr: PrSummary) => { verified.push(pr.number); return { verdict: "accept", merged: true }; },
  });
  const seen = new Map<number, string>();

  const first = await watchTick("o/r", d, seen);
  assert.deepEqual(first.map((a) => a.pr), [7]);
  assert.equal(first[0]!.merged, true);

  const second = await watchTick("o/r", d, seen); // same head → skipped
  assert.deepEqual(second, []);
  assert.deepEqual(verified, [7], "verified exactly once for the head");
});

test("a new head re-verifies", async () => {
  let sha = "aaa";
  const d = deps({ listOpenPrs: async () => [{ number: 7, headSha: sha }], listIssueComments: async () => APPROVE });
  const seen = new Map<number, string>();
  await watchTick("o/r", d, seen);
  sha = "bbb"; // new push
  const again = await watchTick("o/r", d, seen);
  assert.deepEqual(again.map((a) => a.pr), [7]);
});

test("a non-approved PR is skipped (not verified, not marked seen)", async () => {
  const d = deps({
    listOpenPrs: async () => [{ number: 7, headSha: "aaa" }],
    listIssueComments: async () => [{ body: "### Code Review by Claude\n\n⚠️ **NEEDS WORK**" }],
    verify: async () => { throw new Error("should not verify a non-approved PR"); },
  });
  const acted = await watchTick("o/r", deps(d), new Map());
  assert.deepEqual(acted, []);
});

test("a single PR's verify error is recorded and does not abort the tick", async () => {
  const d = deps({
    listOpenPrs: async () => [
      { number: 1, headSha: "a" },
      { number: 2, headSha: "b" },
    ],
    listIssueComments: async () => APPROVE,
    verify: async (pr: PrSummary) => {
      if (pr.number === 1) throw new Error("boom");
      return { verdict: "accept", merged: true };
    },
  });
  const acted = await watchTick("o/r", d, new Map());
  assert.equal(acted.length, 2);
  assert.equal(acted.find((a) => a.pr === 1)!.verdict, "error");
  assert.equal(acted.find((a) => a.pr === 2)!.merged, true);
});

test("a thrown verify is not deduped — it retries on the next tick (review fix)", async () => {
  let attempts = 0;
  const seen = new Map<number, string>();
  const d = deps({
    listOpenPrs: async () => [{ number: 7, headSha: "aaa" }],
    listIssueComments: async () => APPROVE,
    verify: async () => {
      attempts++;
      if (attempts === 1) throw new Error("transient");
      return { verdict: "accept", merged: true };
    },
  });
  const t1 = await watchTick("o/r", d, seen);
  assert.equal(t1[0]!.verdict, "error");
  const t2 = await watchTick("o/r", d, seen);
  assert.equal(t2[0]!.verdict, "accept", "retried after a transient verify error (not permanently skipped)");
  assert.equal(attempts, 2);
});

test("comment-fetch failure for a PR is skipped without marking it seen (retries next tick)", async () => {
  let calls = 0;
  const seen = new Map<number, string>();
  const d = deps({
    listOpenPrs: async () => [{ number: 7, headSha: "aaa" }],
    listIssueComments: async () => { calls++; if (calls === 1) throw new Error("transient"); return APPROVE; },
  });
  const first = await watchTick("o/r", d, seen);
  assert.deepEqual(first, [], "transient comment error → skipped this tick");
  const second = await watchTick("o/r", d, seen);
  assert.deepEqual(second.map((a) => a.pr), [7], "retried on the next tick");
});
