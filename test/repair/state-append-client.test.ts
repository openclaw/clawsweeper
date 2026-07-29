import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  postCanonicalCommitRecords,
  postCanonicalRecordTuple,
} from "../../dist/repair/state-append-client.js";

const webhookSecret = "canonical-state-test-secret";

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
      { ok: true, accepted: true, deduped: false, revision: 3 },
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
    { revision: 3, deduped: false },
  );
});

test("postCanonicalCommitRecords signs immutable commit records", async () => {
  const records = [{ sha: "a".repeat(40), content: "commit report\n", digest: "b".repeat(64) }];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(input.toString(), "https://queue.test/internal/state/records/commits");
    assert.equal(init?.method, "POST");
    const body = String(init?.body ?? "");
    assert.deepEqual(JSON.parse(body), { repo_slug: "openclaw-openclaw", records });
    assert.equal(
      new Headers(init?.headers).get("x-clawsweeper-exact-review-signature"),
      `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`,
    );
    return Response.json({ ok: true, inserted: 1, unchanged: 0 }, { status: 202 });
  }) as typeof fetch;

  assert.deepEqual(
    await postCanonicalCommitRecords({
      queueUrl: "https://queue.test/",
      webhookSecret,
      repoSlug: "openclaw-openclaw",
      records,
      fetchImpl,
    }),
    { inserted: 1, unchanged: 0 },
  );
});

test("canonical commit publication redacts the webhook secret from client errors", async () => {
  const fetchImpl = (async () => {
    throw new Error(`request leaked ${webhookSecret}`);
  }) as typeof fetch;

  await assert.rejects(
    postCanonicalCommitRecords({
      queueUrl: "https://queue.test",
      webhookSecret,
      repoSlug: "openclaw-openclaw",
      records: [{ sha: "a".repeat(40), content: "report", digest: "b".repeat(64) }],
      fetchImpl,
    }),
    (error: Error) => {
      assert.match(error.message, /request leaked <redacted>/);
      assert.doesNotMatch(error.message, new RegExp(webhookSecret));
      return true;
    },
  );
});
