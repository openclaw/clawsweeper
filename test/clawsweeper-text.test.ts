import assert from "node:assert/strict";
import test from "node:test";

import { trimMiddle } from "../dist/clawsweeper-text.js";

test("trimMiddle keeps small-cap output within the requested length", () => {
  assert.equal(trimMiddle("x".repeat(25), 20), "x".repeat(20));
  assert.equal(trimMiddle("x".repeat(125), 120), "x".repeat(120));
  assert.equal(trimMiddle("x".repeat(125), 121), "x".repeat(121));
  assert.equal(trimMiddle("x".repeat(25), 0), "");
  assert.equal(trimMiddle("x".repeat(25), -1), "");
});

test("trimMiddle reports a valid removed count for the middle-elision path", () => {
  const text = "y".repeat(5000);
  const output = trimMiddle(text, 4000);
  const match = output.match(/truncated (\d+) chars/);
  assert.ok(match);
  const removed = Number(match[1]);
  assert.ok(removed >= 0 && removed <= text.length);
  assert.ok(output.length <= 4000);
  assert.ok(output.startsWith("y") && output.endsWith("y"));
});
