import assert from "node:assert/strict";
import test from "node:test";

import { compactText, slug } from "../../dist/repair/text-utils.js";

test("compactText never exceeds maxLength, even for tiny caps", () => {
  for (const n of [0, 1, 2, 3, 5, 16]) {
    assert.ok(
      compactText("hello world this is long", n).length <= n,
      `compactText(..., ${n}) must fit within ${n}`,
    );
  }
  // Regression: maxLength 2 used to return the bare "..." (length 3).
  assert.equal(compactText("hello world", 2), "he");
  assert.equal(compactText("abcdefghijklmnopqrstuvwxyz", 3), "...");
  assert.equal(compactText("abcdefghijklmnopqrstuvwxyz", 4), "a...");
  assert.equal(compactText("abcdefghijklmnopqrstuvwxyz", 16), "abcdefghijklm...");
  assert.equal(compactText("abcdefghijklmnopqrstuvwxyz", 17), "abcdef ... uvwxyz");
});

test("slug remains idempotent when truncation lands on a dash", () => {
  for (const [value, maxLength] of [
    ["a a", 2],
    ["aa----bb", 3],
    ["My Repo Name!!", 6],
    ["a---b", 3],
  ] as const) {
    const result = slug(value, "fallback", maxLength);
    assert.equal(result.endsWith("-"), false);
    assert.equal(slug(result, "fallback", maxLength), result);
  }

  assert.equal(slug("a a", "fallback", 2), "a");
  assert.equal(slug("---", "fallback", 2), "fallback");
});
