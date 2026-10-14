import assert from "node:assert/strict";
import test from "node:test";

import { compactText, stripAnsi } from "../../dist/repair/text-utils.js";
import { ghErrorText } from "../../dist/repair/github-cli.js";

test("command diagnostics remove ANSI control sequences without losing message text", () => {
  const colored = "\u001b[31mfailed\u001b[0m: \u001b[1;4mretained details\u001b[0m";
  const plain = "failed: retained details";
  assert.equal(stripAnsi(colored), plain);
  assert.equal(stripAnsi("plain [31m text\n"), "plain [31m text\n");
  assert.equal(stripAnsi(""), "");
  assert.equal(ghErrorText(new Error(colored)), plain);
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
