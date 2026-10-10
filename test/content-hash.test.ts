import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { sha256 } from "../dist/content-hash.js";

test("sha256 matches the raw createHash digest for strings and bytes", () => {
  assert.equal(sha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  for (const text of [
    "",
    "abc",
    "linux\0pid 42",
    "ünïcödé — 🦞",
    JSON.stringify({ a: [1, "b"] }),
  ]) {
    const raw = createHash("sha256").update(text).digest("hex");
    const bytes = Buffer.from(text, "utf8");
    assert.equal(sha256(text), raw);
    assert.equal(sha256(text), createHash("sha256").update(text, "utf8").digest("hex"));
    assert.equal(sha256(bytes), createHash("sha256").update(bytes).digest("hex"));
    assert.equal(sha256(new Uint8Array(bytes)), raw);
    assert.equal(sha256(bytes), raw);
  }
});
