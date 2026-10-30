import assert from "node:assert/strict";
import test from "node:test";
import { gzip } from "pako";
import {
  decodeStoredJson,
  encodeStoredJson,
  STORED_JSON_MAX_BYTES,
  STORED_JSON_PLACEHOLDER,
  STORED_JSON_PREFIX,
  StoredJsonCorruptionError,
} from "../dashboard/stored-json.ts";

function envelope(text: string, size = new TextEncoder().encode(text).length, marker = "-") {
  const bytes = gzip(new TextEncoder().encode(text));
  return `${STORED_JSON_PREFIX}${size}:${marker}:${Buffer.from(bytes).toString("base64")}`;
}

test("stored text roundtrips raw bytes, Unicode, escapes, whitespace and unknown fields", () => {
  for (const raw of [
    "{}",
    "not JSON",
    "",
    `\ufeff${"BOM text ".repeat(1000)}`,
    ` { "z": "${"🦊漢字\\n\\u0000".repeat(500)}", "legacy": [1, null], "z": 2 }\n`,
  ]) {
    const encoded = encodeStoredJson(raw);
    assert.equal(decodeStoredJson(encoded), raw);
    assert.ok(Buffer.byteLength(encoded) <= Buffer.byteLength(raw));
  }
  assert.ok(
    encodeStoredJson(JSON.stringify({ body: "a".repeat(4096) })).startsWith(STORED_JSON_PREFIX),
  );
  const oversized = "x".repeat(STORED_JSON_MAX_BYTES + 1);
  assert.equal(encodeStoredJson(oversized), oversized);
  assert.equal(decodeStoredJson(oversized), oversized);
});

test("literal marker presence survives encoding regardless of its JSON location", () => {
  for (const value of [
    { body: STORED_JSON_PLACEHOLDER },
    { body: "ordinary", unrelated: STORED_JSON_PLACEHOLDER },
    { body: `escaped \\${STORED_JSON_PLACEHOLDER}` },
    { body: "ClawSweeper status: review started" },
  ]) {
    const raw = JSON.stringify({ ...value, padding: "p".repeat(4096) });
    const encoded = encodeStoredJson(raw);
    assert.ok(encoded.startsWith(STORED_JSON_PREFIX));
    assert.equal(encoded.includes(STORED_JSON_PLACEHOLDER), raw.includes(STORED_JSON_PLACEHOLDER));
    assert.equal(decodeStoredJson(encoded), raw);
  }
});

test("encoded corruption never yields partial, empty or replacement text", () => {
  const raw = JSON.stringify({ body: "hello".repeat(1000) });
  const valid = envelope(raw);
  const corruptCrc = Buffer.from(gzip(Buffer.from(raw)));
  corruptCrc[corruptCrc.length - 8]! ^= 1;
  for (const corrupt of [
    "!cs-json:unknown",
    valid.slice(0, -4),
    valid.replace(/.$/, "?"),
    envelope(raw, 1),
    envelope(raw, STORED_JSON_MAX_BYTES + 1),
    envelope(raw, Buffer.byteLength(raw) + 1),
    envelope(raw, Buffer.byteLength(raw), STORED_JSON_PLACEHOLDER),
    envelope(STORED_JSON_PLACEHOLDER),
    `${STORED_JSON_PREFIX}${Buffer.byteLength(raw)}:-:${corruptCrc.toString("base64")}`,
    valid.slice(0, valid.lastIndexOf(":")) +
      ":" +
      Buffer.concat([Buffer.from(gzip(Buffer.from(raw))), Buffer.from([0])]).toString("base64"),
    `${STORED_JSON_PREFIX}1:-:${Buffer.from(gzip(Uint8Array.of(255))).toString("base64")}`,
  ])
    assert.throws(() => decodeStoredJson(corrupt), StoredJsonCorruptionError);
  assert.equal(decodeStoredJson(valid), raw);
});
