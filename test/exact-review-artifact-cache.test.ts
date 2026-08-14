import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";

import {
  EXACT_REVIEW_ARTIFACT_CACHE_PREFIX,
  EXACT_REVIEW_ARTIFACT_RECEIPT_RETENTION_MS,
  ExactReviewArtifactReceiptStore,
} from "../dashboard/exact-review-artifact-cache.ts";
import worker, { ExactReviewQueue } from "../dashboard/worker.ts";
import { MemoryDurableNamespace, MemoryDurableStorage } from "./dashboard-worker-harness.ts";

const webhookSecret = "artifact-cache-webhook-placeholder";
const operatorSecret = "artifact-cache-operator-placeholder";
const tuple = {
  producer_run_id: "12001",
  producer_run_attempt: 2,
  artifact_name: "exact-review-12001-2",
  canonical_item_key: "openclaw/openclaw#81234",
  lease_revision: 7,
  protocol_version: 2,
};

test("artifact receipts bind the complete publication tuple and remain immutable", async () => {
  const now = Date.parse("2026-08-14T00:00:00Z");
  const storage = new MemoryDurableStorage();
  const bucket = new ArtifactBucket();
  const store = new ExactReviewArtifactReceiptStore(storage, bucket);
  store.ensureSchemaSync();
  const content = Buffer.from("content-addressed exact-review bundle");
  const digest = sha256(content);
  bucket.seed(digest, content, now);

  const first = await store.store({ ...tuple, digest, bytes: content.byteLength }, now);
  assert.equal(first.ok, true);
  assert.equal(first.ok && first.deduped, false);
  assert.equal(store.lookup(tuple, now + 1)?.digest, digest);
  assert.equal(store.lookup({ ...tuple, lease_revision: 8 }, now + 1), null);
  assert.equal(store.lookup({ ...tuple, producer_run_attempt: 3 }, now + 1), null);

  const repeat = await store.store({ ...tuple, digest, bytes: content.byteLength }, now + 2);
  assert.equal(repeat.ok, true);
  assert.equal(repeat.ok && repeat.deduped, true);

  const different = Buffer.from("different bundle bytes");
  const differentDigest = sha256(different);
  bucket.seed(differentDigest, different, now + 3);
  const conflict = await store.store(
    { ...tuple, digest: differentDigest, bytes: different.byteLength },
    now + 3,
  );
  assert.deepEqual(conflict, {
    ok: false,
    error: "artifact_receipt_immutable_conflict",
    status: 409,
  });
});

test("artifact cache retention prunes expired receipts and old unreferenced R2 objects", async () => {
  const now = Date.parse("2026-08-14T00:00:00Z");
  const storage = new MemoryDurableStorage();
  const bucket = new ArtifactBucket();
  const store = new ExactReviewArtifactReceiptStore(storage, bucket);
  store.ensureSchemaSync();
  const referenced = Buffer.from("referenced");
  const referencedDigest = sha256(referenced);
  const orphan = Buffer.from("orphan");
  const orphanDigest = sha256(orphan);
  bucket.seed(referencedDigest, referenced, now);
  bucket.seed(orphanDigest, orphan, now);
  assert.equal(
    (await store.store({ ...tuple, digest: referencedDigest, bytes: referenced.byteLength }, now))
      .ok,
    true,
  );

  const pruned = await store.prune(now + EXACT_REVIEW_ARTIFACT_RECEIPT_RETENTION_MS + 1);
  assert.equal(pruned.receiptsDeleted, 1);
  assert.equal(pruned.objectsDeleted, 2);
  assert.equal(bucket.keys().length, 0);
  assert.equal(store.lookup(tuple, now + EXACT_REVIEW_ARTIFACT_RECEIPT_RETENTION_MS + 1), null);
});

test("Worker artifact receipt endpoints use publisher scope, not operator scope", async () => {
  const now = Date.now();
  const storage = new MemoryDurableStorage();
  const bucket = new ArtifactBucket();
  const content = Buffer.from("signed cache object");
  const digest = sha256(content);
  bucket.seed(digest, content, now);
  const queue = new ExactReviewQueue({ storage }, { STATE_SNAPSHOTS: bucket });
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: webhookSecret,
    EXACT_REVIEW_OPERATOR_SECRET: operatorSecret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const storeBody = JSON.stringify({ ...tuple, digest, bytes: content.byteLength });
  const url = "https://clawsweeper.openclaw.ai/internal/exact-review/artifact-cache/receipt/store";

  assert.equal(
    (await worker.fetch(new Request(url, { method: "POST", body: storeBody }), env)).status,
    401,
  );
  assert.equal(
    (await worker.fetch(signedRequest(url, storeBody, operatorSecret), env)).status,
    401,
  );
  const stored = await worker.fetch(signedRequest(url, storeBody, webhookSecret), env);
  assert.equal(stored.status, 201);
  assert.equal((await stored.json()).receipt.digest, digest);

  const lookupBody = JSON.stringify(tuple);
  const lookup = await worker.fetch(
    signedRequest(
      "https://clawsweeper.openclaw.ai/internal/exact-review/artifact-cache/receipt/lookup",
      lookupBody,
      webhookSecret,
    ),
    env,
  );
  assert.equal(lookup.status, 200);
  assert.equal((await lookup.json()).hit, true);
});

class ArtifactBucket {
  private readonly objects = new Map<
    string,
    {
      bytes: Uint8Array;
      uploaded: Date;
      customMetadata: Record<string, string>;
    }
  >();

  seed(digest: string, content: Uint8Array, uploadedAt: number) {
    this.objects.set(`${EXACT_REVIEW_ARTIFACT_CACHE_PREFIX}${digest}`, {
      bytes: new Uint8Array(content).slice(),
      uploaded: new Date(uploadedAt),
      customMetadata: { sha256: digest, verified: "server" },
    });
  }

  async head(key: string) {
    const object = this.objects.get(key);
    return object ? descriptor(key, object) : null;
  }

  async list(options: { prefix: string; cursor?: string; limit: number }) {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(options.prefix)).sort();
    const start = options.cursor ? Number(options.cursor) : 0;
    const selected = keys.slice(start, start + options.limit);
    const truncated = start + selected.length < keys.length;
    return {
      objects: selected.map((key) => descriptor(key, this.objects.get(key)!)),
      truncated,
      ...(truncated ? { cursor: String(start + selected.length) } : {}),
    };
  }

  async delete(key: string) {
    this.objects.delete(key);
  }

  keys() {
    return [...this.objects.keys()];
  }
}

function descriptor(
  key: string,
  object: { bytes: Uint8Array; uploaded: Date; customMetadata: Record<string, string> },
) {
  return {
    key,
    size: object.bytes.byteLength,
    uploaded: object.uploaded,
    customMetadata: object.customMetadata,
  };
}

function signedRequest(url: string, body: string, secret: string) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
    body,
  });
}

function sha256(content: Uint8Array) {
  return createHash("sha256").update(content).digest("hex");
}
