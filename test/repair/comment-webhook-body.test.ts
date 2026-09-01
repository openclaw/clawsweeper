import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";

import { readBody, WEBHOOK_MAX_BODY_BYTES } from "../../dist/repair/comment-webhook.js";

function requestBody(t: TestContext, chunks: Iterable<Buffer>, length?: number) {
  const request = Object.assign(Readable.from(chunks), {
    headers: length === undefined ? {} : { "content-length": String(length) },
  }) as IncomingMessage;
  t.after(() => request.destroy());
  return request;
}

for (const declared of [true, false]) {
  test(`webhook body accepts bounded UTF-8 input with ${declared ? "declared" : "streamed"} length`, async (t) => {
    const body = Buffer.from("signed 🦞 delivery");
    const request = requestBody(
      t,
      [body.subarray(0, 9), body.subarray(9)],
      declared ? body.length : undefined,
    );
    assert.equal(await readBody(request), body.toString("utf8"));
  });
}

test("webhook body rejects an oversized declaration without pulling input", async (t) => {
  let pulled = false;
  function* chunks() {
    pulled = true;
    yield Buffer.from("unread");
  }
  const request = requestBody(t, chunks(), WEBHOOK_MAX_BODY_BYTES + 1);
  await assert.rejects(readBody(request), /request body exceeds/);
  assert.equal(pulled, false);
  assert.equal(request.destroyed, false);
});

test("webhook body accepts the exact byte limit", async (t) => {
  const request = requestBody(t, [Buffer.alloc(WEBHOOK_MAX_BODY_BYTES, 120)]);
  assert.equal(Buffer.byteLength(await readBody(request)), WEBHOOK_MAX_BODY_BYTES);
});

test("webhook body stops oversized streamed input while leaving the HTTP response usable", async (t) => {
  const request = requestBody(t, [Buffer.alloc(WEBHOOK_MAX_BODY_BYTES, 120), Buffer.from("x")]);
  await assert.rejects(readBody(request), /request body exceeds/);
  assert.equal(request.destroyed, false);
});
