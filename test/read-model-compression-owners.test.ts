import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { GithubWebhookReadModelStore } from "../dashboard/github-webhook-read-model.ts";
import { ExactReviewLifecycleProjectionStore } from "../dashboard/exact-review-lifecycle.ts";
import {
  ReadModelCompressionStore,
  READ_MODEL_COMPRESSION_TABLES,
} from "../dashboard/read-model-compression.ts";
import {
  decodeStoredJson,
  STORED_JSON_PLACEHOLDER,
  STORED_JSON_PREFIX,
  StoredJsonCorruptionError,
} from "../dashboard/stored-json.ts";
import { TestStorage } from "./exact-review-test-storage.ts";
import {
  ExactReviewQueue,
  MemoryDurableNamespace,
  MemoryDurableStorage,
  worker,
} from "./dashboard-worker-harness.ts";

test("webhook migration preserves reads, digests, SQL placeholder protection and tombstones", async () => {
  const storage = new TestStorage();
  const store = new GithubWebhookReadModelStore(storage);
  store.ensureSchemaSync();
  new ExactReviewLifecycleProjectionStore(storage).ensureSchemaSync();
  const now = Date.now(),
    repository = "example/project";
  const sourceUpdatedAt = new Date(now).toISOString();
  const item = {
    kind: "item" as const,
    repository,
    number: 1,
    itemKind: "issue" as const,
    sourceUpdatedAt,
    snapshot: { number: 1, comments: 2, state: "open", body: "x".repeat(8192) },
  };
  const comment = {
    kind: "comment" as const,
    repository,
    number: 1,
    id: 1,
    sourceUpdatedAt,
    tombstone: false,
    snapshot: { id: 1, body: `${STORED_JSON_PLACEHOLDER}\n${"x".repeat(8192)}` },
  };
  store.ingest(
    {
      version: 1,
      deliveryId: "one",
      event: "issue_comment",
      action: "created",
      receivedAt: sourceUpdatedAt,
      eventClasses: ["issues", "issue_comments"],
      objects: [
        item,
        comment,
        { ...comment, id: 2, tombstone: true, snapshot: { id: 2, body: "deleted" } },
      ],
    },
    now,
  );
  store.repair({ repository, repair_kind: "placeholders", objects: [] }, now);
  const read = async () => [
    await store.readItem({ repository, number: 1 }, now),
    await store.readComments({ repository, number: 1 }, now),
    await store.readPlaceholders({ repository, state: "open" }, now),
  ];
  const before = await read();
  const compression = new ReadModelCompressionStore(storage);
  compression.commit(compression.prepare(), now);
  assert.deepEqual(await read(), before);
  assert.ok(
    String(
      [
        ...storage.sql.exec(
          "SELECT snapshot_json FROM github_webhook_read_model_comments_v1 WHERE comment_id=1",
        ),
      ][0]!.snapshot_json,
    ).startsWith(STORED_JSON_PREFIX),
  );
  const retained = store.prunePayloadsSync(now + 31 * 60_000);
  assert.equal(retained.retired, 0);
  assert.equal(retained.protected, 2);
  assert.deepEqual((await read())[1], before[1]);
  store.repair(
    {
      repository,
      repair_kind: "comments",
      objects: [{ ...comment, snapshot: { id: 1, body: "resolved" } }],
      complete_comment_items: [1],
    },
    now + 1,
  );
  assert.deepEqual((await store.readComments({ repository, number: 1 }, now + 2)).tombstones, [2]);
});

test("lifecycle physical conversion keeps historical fields, terminal and acknowledgement authority", () => {
  const storage = new TestStorage();
  new GithubWebhookReadModelStore(storage).ensureSchemaSync();
  const store = new ExactReviewLifecycleProjectionStore(storage);
  const identity = {
    canonicalTargetKey: "example/project#1",
    fenceKey: "example/project#1",
    revision: 1,
  };
  const now = Date.now();
  store.recordAdmission({
    ...identity,
    deliveryId: "admission",
    sourceDeliveryId: "source",
    sourceAction: "created",
    commandOriginated: true,
    statusMarker: "status:one",
    statusCommentId: 3,
    triggeredAt: now,
    observedAt: now,
  });
  store.recordTerminalDisposition({
    ...identity,
    kind: "policy_noop",
    operationId: "terminal:one",
    observedAt: now + 1,
  });
  const before = store.read(identity.canonicalTargetKey, identity.fenceKey, identity.revision)!;
  const raw =
    JSON.stringify({ ...before, inlineProof: { unknown: "keep".repeat(1024) } }, null, 2) + "\n";
  storage.run("UPDATE exact_review_lifecycle_projection_v1 SET projection_json=?", raw);
  const compression = new ReadModelCompressionStore(storage);
  compression.commit(compression.prepare(), now + 2);
  const saved = String(
    [...storage.sql.exec("SELECT projection_json FROM exact_review_lifecycle_projection_v1")][0]!
      .projection_json,
  );
  assert.equal(decodeStoredJson(saved), raw);
  const restart = new ExactReviewLifecycleProjectionStore(storage);
  assert.deepEqual(
    restart.read(identity.canonicalTargetKey, identity.fenceKey, identity.revision),
    before,
  );
  const attempt = restart.authorizeCommandAcknowledgement({
    ...identity,
    statusMarker: "status:one",
    statusCommentId: 3,
    observedAt: now + 3,
  });
  assert.equal(attempt.allowed, true);
  assert.equal(
    restart.recordCommandAcknowledgementFailure({
      ...identity,
      attemptId: attempt.attemptId!,
      statusMarker: "status:one",
      statusCommentId: 3,
      observedAt: now + 4,
    }).released,
    true,
  );
  assert.equal(
    restart.authorizeCommandAcknowledgement({
      ...identity,
      statusMarker: "status:one",
      statusCommentId: 3,
      observedAt: now + 5,
    }).allowed,
    true,
  );
  assert.equal(
    restart.read(identity.canonicalTargetKey, identity.fenceKey, 1)!.terminalDisposition!.kind,
    "policy_noop",
  );
});

test("codec corruption stays an infrastructure failure through queue reads and HMAC maintenance is gated", async (t) => {
  t.mock.method(console, "error", () => {});
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, { CLAWSWEEPER_DEPLOY_SHA: "a".repeat(40) });
  await queue.fetch(new Request("https://queue/admission-capabilities", { method: "POST" }));
  storage.sql.exec(`INSERT INTO github_webhook_read_model_items_v1
    (repository, number, item_kind, source_updated_at, snapshot_json, delivery_id, watermark, received_at)
    VALUES ('example/project', 1, 'issue', 1, '!cs-json:broken', 'one', 1, 1)`);
  await assert.rejects(
    queue.fetch(
      new Request("https://queue/github-read-model/item", {
        method: "POST",
        body: JSON.stringify({ repository: "example/project", number: 1 }),
      }),
    ),
    StoredJsonCorruptionError,
  );
  storage.sql.exec("DELETE FROM github_webhook_read_model_items_v1");
  const delivery = (id: string, number: number) => ({
    version: 1,
    deliveryId: id,
    event: "issues",
    action: "opened",
    receivedAt: new Date().toISOString(),
    eventClasses: ["issues"],
    objects: [
      {
        kind: "item",
        repository: "example/project",
        number,
        itemKind: "issue",
        sourceUpdatedAt: new Date().toISOString(),
        snapshot: { body: "z".repeat(4096) },
      },
    ],
  });
  const ingest = (target: ExactReviewQueue, id: string, number: number) =>
    target.fetch(
      new Request("https://queue/github-read-model/ingest", {
        method: "POST",
        body: JSON.stringify(delivery(id, number)),
      }),
    );
  assert.equal((await ingest(queue, "before", 1)).status, 202);
  const stored = (number: number) =>
    String(
      [
        ...storage.sql.exec(
          "SELECT snapshot_json FROM github_webhook_read_model_items_v1 WHERE number=?",
          number,
        ),
      ][0]!.snapshot_json,
    );
  assert.ok(stored(1).startsWith("{"), "deployment alone stays a raw writer");
  const secret = "synthetic-secret";
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const call = (body: Record<string, unknown>, signed = true) => {
    const text = JSON.stringify(body);
    return worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/internal/exact-review/read-model/compression", {
        method: "POST",
        body: text,
        headers: signed
          ? {
              "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", secret).update(text).digest("hex")}`,
            }
          : {},
      }),
      env,
    );
  };
  assert.equal((await call({ action: "preview" }, false)).status, 401);
  assert.equal(
    (await call({ action: "preview", expectedDeploymentSha: "b".repeat(40) })).status,
    409,
  );
  const preview = await (
    await call({ action: "preview", expectedDeploymentSha: "a".repeat(40) })
  ).json();
  assert.equal(preview.plan.tables.length, READ_MODEL_COMPRESSION_TABLES.length);
  assert.equal(
    (
      await call({
        action: "migrate",
        expectedDeploymentSha: "a".repeat(40),
        reviewedPreviewSha256: preview.sha256,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call({
        action: "migrate",
        execute: true,
        expectedDeploymentSha: "a".repeat(40),
        reviewedPreviewSha256: "b".repeat(64),
      })
    ).status,
    409,
  );
  const response = await call({
    action: "migrate",
    execute: true,
    expectedDeploymentSha: "a".repeat(40),
    reviewedPreviewSha256: preview.sha256,
  });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).checkpoint.completedAt);
  assert.ok(stored(1).startsWith(STORED_JSON_PREFIX));
  assert.equal((await ingest(queue, "warm", 2)).status, 202);
  assert.ok(
    stored(2).startsWith(STORED_JSON_PREFIX),
    "warm owner changes its encoder after commit",
  );
  const restarted = new ExactReviewQueue({ storage }, { CLAWSWEEPER_DEPLOY_SHA: "a".repeat(40) });
  assert.equal((await ingest(restarted, "restart", 3)).status, 202);
  assert.ok(stored(3).startsWith(STORED_JSON_PREFIX));
});
