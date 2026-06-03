/**
 * IN-558: criteria extraction must handle alternate headings and requirements stated as
 * numbered feature points / normative prose, not only a literal "## Acceptance Criteria" block.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractExplicitCriteria } from "./parser.js";
import type { IssueContext } from "../../types.js";

const issue = (description: string): IssueContext => ({
  key: "IN-X",
  title: "t",
  description,
  url: "u",
  source: "test",
});

test("alternate heading 'Requirements' with bullets is recognized", () => {
  const c = extractExplicitCriteria(
    issue("## Requirements\n\n- `sy ping` exits 0\n- `sy ping` prints pong\n"),
  );
  assert.equal(c.length, 2);
  assert.match(c[0]!.text, /sy ping/);
});

test("no AC heading: testable requirements are recovered from numbered feature prose", () => {
  const c = extractExplicitCriteria(
    issue(
      "## Summary\nAdd a `sy info` command.\n\n" +
        "### 1. Version line\nThe command must print `Symphony <version>` and exit 0.\n\n" +
        "### 2. JSON\nIt should support a `--json` flag that returns valid JSON.\n\n" +
        "### Notes\nThis is internal.\n",
    ),
  );
  // The two normative sentences are captured; the summary and the "internal" note are not.
  assert.equal(c.length, 2);
  assert.match(c[0]!.text, /must print/i);
  assert.match(c[1]!.text, /should support/i);
  assert.ok(!c.some((x) => /internal/i.test(x.text)), "non-normative prose must not be captured");
});

test("a plain summary with no normative cues yields nothing (no over-extraction)", () => {
  const c = extractExplicitCriteria(issue("## Summary\nThis ticket adds a dashboard page.\n"));
  assert.equal(c.length, 0);
});

test("regression: a literal Acceptance Criteria block still extracts exactly its bullets", () => {
  const c = extractExplicitCriteria(
    issue("## Acceptance Criteria\n\n* `sy --version` prints Symphony and exits 0.\n* Reads version from metadata.\n\n## Hint\nUse importlib."),
  );
  assert.equal(c.length, 2);
  assert.ok(!c.some((x) => /importlib/.test(x.text)), "the Hint section must not leak in");
});
