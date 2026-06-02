import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson } from "./json.js";

test("parses plain JSON", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
});

test("parses fenced JSON with prose around it", () => {
  const text = "Sure!\n```json\n{\"b\": [1,2,3]}\n```\nHope that helps.";
  assert.deepEqual(extractJson(text), { b: [1, 2, 3] });
});

test("extracts the first object when surrounded by text", () => {
  assert.deepEqual(extractJson('noise {"x": "}"} trailing'), { x: "}" });
});

test("throws when no JSON present", () => {
  assert.throws(() => extractJson("no json here"));
});
