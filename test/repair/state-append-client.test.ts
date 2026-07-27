import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  postCanonicalRecordTuple,
  postStateAppend,
} from "../../dist/repair/state-append-client.js";

const webhookSecret = "state-append-test-secret";
const records = [
  {
    kind: "sweep_status" as const,
    key: "results/sweep-status/openclaw-openclaw.json",
    payload: { slug: "openclaw-openclaw", updated_at: "2026-07-21T12:00:00.000Z" },
    produced_at: "2026-07-21T12:00:00.000Z",
  },
];

test("postCanonicalRecordTuple signs the canonical tuple endpoint", async () => {
  const mutation = {
    deliveryId: "record-tuple:run:1:digest",
    key: "openclaw-openclaw/42",
    operations: [
      {
        path: "records/openclaw-openclaw/items/42.md",
        expectedDigest: null,
        contentBase64: Buffer.from("item\n").toString("base64"),
      },
      { path: "records/openclaw-openclaw/closed/42.md", expectedDigest: null },
      { path: "records/openclaw-openclaw/plans/42.md", expectedDigest: null },
      { path: "records/openclaw-openclaw/decision-packets/42.json", expectedDigest: null },
    ],
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(input.toString(), "https://queue.test/internal/state/records/tuples");
    const body = String(init?.body ?? "");
    assert.deepEqual(JSON.parse(body), mutation);
    assert.equal(
      new Headers(init?.headers).get("x-clawsweeper-exact-review-signature"),
      `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`,
    );
    return Response.json(
      { ok: true, accepted: true, deduped: false, revision: 3, sequence: 9 },
      { status: 202 },
    );
  }) as typeof fetch;

  assert.deepEqual(
    await postCanonicalRecordTuple({
      queueUrl: "https://queue.test",
      webhookSecret,
      mutation,
      fetchImpl,
    }),
    { revision: 3, sequence: 9, deduped: false },
  );
});

test("postStateAppend signs and posts the exact append body", async () => {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(input.toString(), "https://queue.test/internal/state/append");
    assert.equal(init?.method, "POST");
    const body = String(init?.body ?? "");
    assert.deepEqual(JSON.parse(body), { delivery_id: "delivery-1", records });
    assert.equal(
      new Headers(init?.headers).get("x-clawsweeper-exact-review-signature"),
      `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`,
    );
    return Response.json({ ok: true, appended: 1 }, { status: 202 });
  }) as typeof fetch;

  assert.deepEqual(
    await postStateAppend({
      queueUrl: "https://queue.test/",
      webhookSecret,
      deliveryId: "delivery-1",
      records,
      fetchImpl,
    }),
    { ok: true, shed: false, deduped: false },
  );
});

test("postStateAppend propagates an idempotent delivery receipt", async () => {
  const fetchImpl = (async () =>
    Response.json({ ok: true, deduped: true }, { status: 202 })) as typeof fetch;

  assert.deepEqual(
    await postStateAppend({
      queueUrl: "https://queue.test",
      webhookSecret,
      deliveryId: "delivery-duplicate",
      records,
      fetchImpl,
    }),
    { ok: true, shed: false, deduped: true },
  );
});

test("postStateAppend reports a shed response without throwing", async () => {
  const fetchImpl = (async () =>
    Response.json({ ok: false, shed: true, reason: "capacity" }, { status: 429 })) as typeof fetch;

  assert.deepEqual(
    await postStateAppend({
      queueUrl: "https://queue.test",
      webhookSecret,
      deliveryId: "delivery-shed",
      records,
      fetchImpl,
    }),
    { ok: false, shed: true, deduped: false },
  );
});

test("postStateAppend preserves an explicit unsuccessful response as a fallback signal", async () => {
  const fetchImpl = (async () => Response.json({ ok: false }, { status: 202 })) as typeof fetch;

  assert.deepEqual(
    await postStateAppend({
      queueUrl: "https://queue.test",
      webhookSecret,
      deliveryId: "delivery-failed",
      records,
      fetchImpl,
    }),
    { ok: false, shed: false, deduped: false },
  );
});

test("postStateAppend redacts the webhook secret from client errors", async () => {
  const fetchImpl = (async () => {
    throw new Error(`request leaked ${webhookSecret}`);
  }) as typeof fetch;

  await assert.rejects(
    postStateAppend({
      queueUrl: "https://queue.test",
      webhookSecret,
      deliveryId: "delivery-error",
      records,
      fetchImpl,
    }),
    (error: Error) => {
      assert.match(error.message, /request leaked <redacted>/);
      assert.doesNotMatch(error.message, new RegExp(webhookSecret));
      return true;
    },
  );
});
