import assert from "node:assert/strict";
import test from "node:test";
import {
  GithubWebhookReadModelStore,
  GITHUB_WEBHOOK_READ_MODEL_PAYLOAD_RETENTION_MS,
  WEBHOOK_PAYLOAD_RETENTION_CATEGORIES,
  type GithubWebhookReadModelObject,
} from "../dashboard/github-webhook-read-model.ts";
import { encodeStoredJson, STORED_JSON_PLACEHOLDER } from "../dashboard/stored-json.ts";
import { storageContentPage } from "../dashboard/storage-stats.ts";
import { TestStorage } from "./exact-review-test-storage.ts";

const repository = "example/project";
const asOf = 1_800_000_000_000;
const old = asOf - GITHUB_WEBHOOK_READ_MODEL_PAYLOAD_RETENTION_MS - 1;
const items = "github_webhook_read_model_items_v1";
const comments = "github_webhook_read_model_comments_v1";
const activity = "github_webhook_read_model_activity_v1";

function fixture(count = 9) {
  const storage = new TestStorage();
  const store = new GithubWebhookReadModelStore(storage);
  store.ensureSchemaSync();
  for (let number = 1; number <= count; number++) {
    const objects: GithubWebhookReadModelObject[] = [
      {
        kind: "item",
        repository,
        number,
        itemKind: "issue",
        sourceUpdatedAt: new Date(old).toISOString(),
        snapshot: { number, body: "雪🦊\0" },
      },
      {
        kind: "comment",
        repository,
        number,
        id: number,
        tombstone: number === 3,
        sourceUpdatedAt: new Date(old).toISOString(),
        snapshot: {
          id: number,
          body: [2, 9].includes(number) ? STORED_JSON_PLACEHOLDER : "雪🦊\0",
        },
      },
    ];
    store.ingest(
      {
        version: 1,
        deliveryId: `delivery-${number}`,
        event: "issue_comment",
        action: "created",
        receivedAt: new Date(old).toISOString(),
        eventClasses: ["issue_comments"],
        objects,
      },
      old,
    );
  }
  storage.run(
    `UPDATE ${comments} SET snapshot_json = ? WHERE number = 2`,
    encodeStoredJson(JSON.stringify({ body: `${STORED_JSON_PLACEHOLDER} ${"雪🦊".repeat(1000)}` })),
  );
  storage.exec(`UPDATE ${comments} SET payload_pruned = 1, snapshot_json = '{}' WHERE number = 4`);
  storage.exec(`UPDATE ${comments} SET payload_retire_at = -1 WHERE number = 5`);
  storage.run(
    `UPDATE ${items} SET received_at = ? WHERE number = 6`,
    asOf - GITHUB_WEBHOOK_READ_MODEL_PAYLOAD_RETENTION_MS,
  );
  storage.run(`UPDATE ${comments} SET payload_retire_at = ? WHERE number = 7`, asOf);
  return { storage, store };
}

test("retention census explains stored bytes with the retirement owner's exact precedence", () => {
  const { storage, store } = fixture();
  const before = [items, comments, activity].map((table) => [
    ...storage.sql.exec(`SELECT * FROM ${table}`),
  ]);
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      assert.match(query, /^\s*SELECT\b/i, "diagnostic must issue SELECT only");
      return storage.sql.exec(query, ...bindings);
    },
  };
  const page = storageContentPage(sql, { table: comments, retention: true, asOf });
  assert.ok(page.retention);
  assert.equal(page.retention.asOf, asOf);
  assert.deepEqual(
    Object.fromEntries(Object.entries(page.retention.categories).map(([k, v]) => [k, v.rows])),
    {
      retired: 1,
      tombstone: 1,
      placeholder_comment: 2,
      placeholder_parent: 0,
      stale_protection: 1,
      active_family: 1,
      idle_future_deadline: 1,
      due_eligible: 2,
    },
  );
  assert.equal(
    Object.values(page.retention.categories).reduce((n, v) => n + v.rows, 0),
    page.scannedRows,
  );
  assert.equal(
    Object.values(page.retention.categories).reduce((n, v) => n + v.bytes, 0),
    page.columns.snapshot_json,
  );
  assert.equal(page.retention.categories.retired!.bytes, 2);
  const parents = storageContentPage(sql, { table: items, retention: true, asOf });
  assert.equal(parents.retention!.categories.placeholder_parent!.rows, 2);
  assert.equal(parents.retention!.categories.active_family!.rows, 1);
  assert.deepEqual(
    [items, comments, activity].map((table) => [...storage.sql.exec(`SELECT * FROM ${table}`)]),
    before,
  );
  assert.equal(storage.scheduledAlarm(), null);

  // With fewer than 64 candidates, due_eligible predicts exactly the ordinary
  // comment rows that the real owner retires in the same execution order.
  store.prunePayloadsSync(asOf);
  assert.equal(
    storage.scalar(`SELECT COUNT(*) AS value FROM ${comments} WHERE payload_pruned = 1`) - 1,
    page.retention.categories.due_eligible!.rows,
  );
});

test("retention pages keep their time and frontier across gaps, growth and deletion", () => {
  const { storage } = fixture(66);
  storage.exec(`DELETE FROM ${comments} WHERE number = 10`);
  const first = storageContentPage(storage.sql, { table: comments, retention: true, asOf });
  assert.equal(first.scannedRows, 64);
  assert.deepEqual(first.nextCursor, { afterRowid: 65, upperRowid: 66, retention: true, asOf });
  storage.exec(`INSERT INTO ${comments}
    (repository, number, comment_id, source_updated_at, tombstone, snapshot_json,
     delivery_id, watermark, received_at, payload_pruned, payload_retire_at)
    SELECT repository, 100, 100, source_updated_at, tombstone, snapshot_json,
    delivery_id, watermark, received_at, payload_pruned, payload_retire_at
    FROM ${comments} WHERE number = 66`);
  const last = storageContentPage(storage.sql, { table: comments, ...first.nextCursor });
  assert.equal(last.scannedRows, 1);
  assert.equal(last.retention!.asOf, asOf);
  assert.equal(last.complete, true);
  storage.exec(`DELETE FROM ${comments} WHERE number = 66`);
  const empty = storageContentPage(storage.sql, { table: comments, ...first.nextCursor });
  assert.equal(empty.scannedRows, 0);
  assert.equal(empty.complete, true);
  assert.deepEqual(
    Object.values(empty.retention!.categories),
    WEBHOOK_PAYLOAD_RETENTION_CATEGORIES.map(() => ({ rows: 0, bytes: 0 })),
  );
});

test("activity and empty collection repairs share family retention", () => {
  const { storage, store } = fixture();
  const objects: GithubWebhookReadModelObject[] = [
    {
      kind: "review",
      repository,
      number: 1,
      id: 1,
      tombstone: false,
      sourceUpdatedAt: new Date(old).toISOString(),
      snapshot: { body: "review" },
    },
    {
      kind: "review_comment",
      repository,
      number: 2,
      id: 2,
      tombstone: true,
      sourceUpdatedAt: new Date(old).toISOString(),
      snapshot: { body: null },
    },
  ];
  store.ingest(
    {
      version: 1,
      deliveryId: "activity",
      event: "pull_request_review",
      action: "submitted",
      receivedAt: new Date(old).toISOString(),
      eventClasses: ["pull_request_reviews"],
      objects,
    },
    old,
  );
  store.repair(
    { repository, repair_kind: "comments", objects: [], complete_comment_items: [1] },
    asOf,
  );
  const page = storageContentPage(storage.sql, { table: activity, retention: true, asOf });
  assert.equal(page.retention!.categories.active_family!.rows, 1);
  assert.equal(page.retention!.categories.tombstone!.rows, 1);
  assert.equal(page.retention!.categories.due_eligible!.rows, 0);
});

test("retention census rejects unsupported or unpinned continuations without schema creation", () => {
  const { storage } = fixture();
  for (const input of [
    { table: comments, retention: "true" },
    { table: comments, retention: true, asOf: -1 },
    { table: comments, retention: true, asOf: 0.5 },
    { table: comments, retention: true, afterRowid: 1, upperRowid: 9 },
    { table: "github_webhook_read_model_deliveries_v1", retention: true },
  ])
    assert.throws(() => storageContentPage(storage.sql, input), /invalid_storage_census_retention/);
  const cold = new TestStorage();
  assert.throws(
    () => storageContentPage(cold.sql, { table: comments, retention: true }),
    /invalid_storage_census_table/,
  );
  assert.deepEqual([...cold.sql.exec("SELECT name FROM sqlite_master WHERE type='table'")], []);
});

test("fresh activity protects old siblings, while activity marker text gets no placeholder exemption", () => {
  const { storage, store } = fixture();
  store.ingest(
    {
      version: 1,
      deliveryId: "fresh-activity",
      event: "pull_request_review",
      action: "submitted",
      receivedAt: new Date(asOf).toISOString(),
      eventClasses: ["pull_request_reviews"],
      objects: [
        {
          kind: "review",
          repository,
          number: 1,
          id: 101,
          tombstone: false,
          sourceUpdatedAt: new Date(asOf).toISOString(),
          snapshot: { body: STORED_JSON_PLACEHOLDER },
        },
      ],
    },
    asOf,
  );
  for (const table of [items, comments, activity]) {
    const page = storageContentPage(storage.sql, { table, retention: true, asOf });
    assert.ok(page.retention!.categories.active_family!.rows >= 1);
  }
  store.prunePayloadsSync(asOf);
  for (const table of [items, comments, activity])
    assert.equal(storage.scalar(`SELECT payload_pruned AS value FROM ${table} WHERE number=1`), 0);
  const expired = asOf + GITHUB_WEBHOOK_READ_MODEL_PAYLOAD_RETENTION_MS + 1;
  const expected = [items, comments, activity].map((table) => ({
    table,
    retired: storage.scalar(`SELECT COUNT(*) AS value FROM ${table} WHERE payload_pruned=1`),
    due: storageContentPage(storage.sql, { table, retention: true, asOf: expired }).retention!
      .categories.due_eligible!.rows,
  }));
  const page = storageContentPage(storage.sql, { table: activity, retention: true, asOf: expired });
  assert.equal(page.retention!.categories.placeholder_comment!.rows, 0);
  assert.equal(page.retention!.categories.due_eligible!.rows, 1);
  store.prunePayloadsSync(expired);
  for (const { table, retired, due } of expected)
    assert.equal(
      storage.scalar(`SELECT COUNT(*) AS value FROM ${table} WHERE payload_pruned=1`) - retired,
      due,
    );
});
