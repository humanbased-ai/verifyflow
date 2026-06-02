import { test } from "node:test";
import assert from "node:assert/strict";
import { extractExplicitCriteria, heuristicProbe } from "./parser.js";
import type { IssueContext } from "../../types.js";

const IN318: IssueContext = {
  key: "IN-318",
  title: "Add `--version` flag to the `sy` CLI",
  description:
    "## Summary\n\n`sy --version` currently errors.\n\n## Acceptance Criteria\n\n" +
    "* `sy --version` prints `Symphony <version>` (e.g. `Symphony 0.1.0`) and exits 0.\n" +
    "* Version value is read from the package metadata (`importlib.metadata`) — not hardcoded.\n\n" +
    "## Implementation Hint\n\nUse importlib.",
  url: "https://linear.app/x/issue/IN-318",
  source: "test",
};

test("extracts exactly the two acceptance criteria, quoted verbatim", () => {
  const criteria = extractExplicitCriteria(IN318);
  assert.equal(criteria.length, 2);
  assert.equal(criteria[0]!.id, "AC-1");
  assert.match(criteria[0]!.text, /^`sy --version` prints/);
  assert.equal(criteria[0]!.source, "linear_explicit");
  // The Implementation Hint heading must NOT be swallowed into the criteria.
  assert.ok(criteria.every((c) => !/importlib\.$/.test(c.text)));
});

test("derives a runnable probe from AC-1 (command + expected output + exit 0)", () => {
  const probe = heuristicProbe(extractExplicitCriteria(IN318)[0]!.text);
  assert.ok(probe, "expected a probe");
  assert.equal(probe!.command, "sy --version");
  assert.equal(probe!.expectSubstring, "Symphony");
  assert.equal(probe!.expectExitCode, 0);
});

test("AC-2 (no runnable command) yields no probe", () => {
  const probe = heuristicProbe(extractExplicitCriteria(IN318)[1]!.text);
  assert.equal(probe, undefined);
});
