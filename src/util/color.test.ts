import { test } from "node:test";
import assert from "node:assert/strict";
import { refreshColor, green, red, yellow, dim, cyan, colorizeVerdict } from "./color.js";

// Each test sets the enablement explicitly via refreshColor(env) so it doesn't depend on whether
// the test runner happens to attach a TTY.

test("NO_COLOR disables color regardless of value", () => {
  refreshColor({ NO_COLOR: "1", FORCE_COLOR: "1" });
  assert.equal(green("ok"), "ok");
  assert.equal(red("x"), "x");
  // empty value still counts as present per the NO_COLOR spec
  refreshColor({ NO_COLOR: "" });
  assert.equal(yellow("y"), "y");
});

test("FORCE_COLOR enables color even without a TTY", () => {
  refreshColor({ FORCE_COLOR: "1" });
  assert.equal(green("ok"), "\x1b[32mok\x1b[0m");
  assert.equal(red("no"), "\x1b[31mno\x1b[0m");
  assert.equal(yellow("warn"), "\x1b[33mwarn\x1b[0m");
  assert.equal(cyan("id"), "\x1b[36mid\x1b[0m");
  assert.equal(dim("detail"), "\x1b[2mdetail\x1b[0m");
});

test("FORCE_COLOR=0 does not force-enable", () => {
  refreshColor({ FORCE_COLOR: "0" });
  assert.equal(green("ok"), "ok");
});

test("TERM=dumb disables color", () => {
  refreshColor({ TERM: "dumb" });
  assert.equal(green("ok"), "ok");
});

test("colorizeVerdict maps severity to color when enabled", () => {
  refreshColor({ FORCE_COLOR: "1" });
  assert.equal(colorizeVerdict("accept"), "\x1b[32maccept\x1b[0m");
  assert.equal(colorizeVerdict("needs_fix"), "\x1b[31mneeds_fix\x1b[0m");
  assert.equal(colorizeVerdict("error"), "\x1b[31merror\x1b[0m");
  assert.equal(colorizeVerdict("manual_review_required"), "\x1b[33mmanual_review_required\x1b[0m");
  // unknown verdicts pass through uncolored
  assert.equal(colorizeVerdict("whatever"), "whatever");
});

test("disabled color leaves verdict strings plain", () => {
  refreshColor({ NO_COLOR: "1" });
  assert.equal(colorizeVerdict("accept"), "accept");
});

// Restore default enablement for any later tests in the same process.
test.after(() => refreshColor());
