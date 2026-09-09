import assert from "node:assert/strict";
import test from "node:test";

import { OutputLastMessageParser } from "../dist/codex-output-last-message.js";

test("managed result parser removes only the native final newline frame", () => {
  for (const text of ["", "answer", " \r\nanswer\t \r\n", "\ufeffanswer", "answer\r"]) {
    const parser = new OutputLastMessageParser(Math.max(1, Buffer.byteLength(text)));
    parser.append(Buffer.from(`${text}\n`));

    assert.deepEqual(parser.finish(), { text });
  }
});

test("managed result parser preserves UTF-8 across arbitrary chunk boundaries", () => {
  const text = "\u00e9 \ud83d\ude80";
  const parser = new OutputLastMessageParser(Buffer.byteLength(text));
  for (const byte of Buffer.from(`${text}\n`)) parser.append(Buffer.from([byte]));

  assert.deepEqual(parser.finish(), { text });
});

test("managed result parser owns its retained input bytes", () => {
  const parser = new OutputLastMessageParser(16);
  const first = Buffer.from("copied ");
  parser.append(first);
  first.fill(0);
  parser.append(Buffer.from("answer\n"));

  assert.deepEqual(parser.finish(), { text: "copied answer" });
});

test("managed result parser accepts the exact payload cap plus one framing byte", () => {
  const parser = new OutputLastMessageParser(4);
  parser.append(Buffer.from("\ud83d\ude80\n"));

  assert.deepEqual(parser.finish(), { text: "\ud83d\ude80" });
});

test("managed result parser rejects cap plus one payload byte before publication", () => {
  const parser = new OutputLastMessageParser(4);
  parser.append(Buffer.from("a\ud83d\ude80"));
  parser.append(Buffer.from("\n"));

  const result = parser.finish();
  assert.match(result.error?.message ?? "", /exceeded its 4-byte limit/);
  assert.equal(result.text, undefined);
  assert.deepEqual(parser.finish(), result);
});

for (const [name, bytes] of [
  ["no output", Buffer.alloc(0)],
  ["missing final frame", Buffer.from("answer")],
  ["carriage return without a newline", Buffer.from("answer\r")],
] as const) {
  test(`managed result parser rejects ${name}`, () => {
    const parser = new OutputLastMessageParser(16);
    parser.append(bytes);

    const result = parser.finish();
    assert.match(result.error?.message ?? "", /newline frame/);
    assert.equal(result.text, undefined);
  });
}

for (const [name, bytes] of [
  ["invalid leading byte", Buffer.from([0xff, 0x0a])],
  ["incomplete multi-byte character", Buffer.from([0xc3, 0x0a])],
  ["invalid bytes after a valid prefix", Buffer.from([0x6f, 0x6b, 0xff, 0x0a])],
  ["overlong encoding", Buffer.from([0xc0, 0xaf, 0x0a])],
] as const) {
  test(`managed result parser rejects ${name}`, () => {
    const parser = new OutputLastMessageParser(16);
    parser.append(bytes);

    const result = parser.finish();
    assert.match(result.error?.message ?? "", /invalid UTF-8/);
    assert.equal(result.text, undefined);
  });
}

test("managed result parser does not reinterpret JSONL-looking payload text", () => {
  const text = '{"type":"turn.failed","error":{"message":"quoted example"}}';
  const parser = new OutputLastMessageParser(Buffer.byteLength(text));
  parser.append(Buffer.from(`${text}\n`));

  assert.deepEqual(parser.finish(), { text });
});

test("managed result parser finishes once and ignores later input", () => {
  const parser = new OutputLastMessageParser(8);
  parser.append(Buffer.from("final\n"));
  assert.deepEqual(parser.finish(), { text: "final" });
  parser.append(Buffer.from("late output\n"));

  assert.deepEqual(parser.finish(), { text: "final" });
});
