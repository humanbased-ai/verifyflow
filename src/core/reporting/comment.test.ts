/**
 * IN-560: a re-run must update VerifyFlow's existing PR comment, not stack a new one. The
 * selection is by a hidden marker so it never touches human or other-bot comments.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { VF_COMMENT_MARKER, selectExistingCommentId } from "./reporter.js";

test("finds the prior VerifyFlow comment by marker", () => {
  const comments = [
    { id: 1, body: "looks good to me" },
    { id: 2, body: `${VF_COMMENT_MARKER}\n# VerifyFlow delivery report …` },
    { id: 3, body: "please rebase" },
  ];
  assert.equal(selectExistingCommentId(comments), 2);
});

test("returns undefined when VerifyFlow has not commented yet (so a new one is created)", () => {
  assert.equal(selectExistingCommentId([{ id: 1, body: "human comment" }]), undefined);
  assert.equal(selectExistingCommentId([]), undefined);
});

test("ignores comments missing a body", () => {
  assert.equal(selectExistingCommentId([{ id: 9 }]), undefined);
});
