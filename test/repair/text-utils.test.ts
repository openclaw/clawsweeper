import assert from "node:assert/strict";
import test from "node:test";

import { compactCommentText, compactText, slug, stripAnsi } from "../../dist/repair/text-utils.js";
import { ghErrorText } from "../../dist/repair/github-cli.js";

test("command diagnostics remove ANSI control sequences without losing message text", () => {
  const colored = "\u001b[31mfailed\u001b[0m: \u001b[1;4mretained details\u001b[0m";
  const plain = "failed: retained details";
  assert.equal(stripAnsi(colored), plain);
  assert.equal(stripAnsi("plain [31m text\n"), "plain [31m text\n");
  assert.equal(stripAnsi(""), "");
  assert.equal(ghErrorText(new Error(colored)), plain);
});

test("comment previews count the ellipsis inside every character cap", () => {
  for (let cap = 0; cap <= 200; cap++) {
    assert.ok(compactCommentText("long comment ".repeat(30), cap).length <= cap);
  }
  assert.equal(compactCommentText("hello world", 0), "");
  assert.equal(compactCommentText("hello world", 2), "he");
  assert.equal(compactCommentText("hello world", 3), "...");
  assert.equal(compactCommentText("hello world", 5), "he...");
  assert.equal(compactCommentText("hello world", 9), "hello...");
  assert.equal(compactCommentText(" \n hello\t world ", 11), "hello world");
  assert.equal(compactCommentText(null, 5), "");
});

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
