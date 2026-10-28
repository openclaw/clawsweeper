import assert from "node:assert/strict";
import test from "node:test";

import {
  GithubWebhookReadModelStore,
  GITHUB_WEBHOOK_READ_MODEL_PAYLOAD_PRUNE_LIMIT,
  GITHUB_WEBHOOK_READ_MODEL_PAYLOAD_RETENTION_MS,
  GITHUB_WEBHOOK_READ_MODEL_COMMENT_TTL_MS,
  type GithubWebhookReadModelObject,
} from "../dashboard/github-webhook-read-model.ts";
import { TestStorage } from "./exact-review-test-storage.ts";
import { storageContentPage } from "../dashboard/storage-stats.ts";
import { encodeStoredJson, STORED_JSON_PLACEHOLDER } from "../dashboard/stored-json.ts";

const repository = "example/project";
const now = Date.parse("2026-10-14T00:00:00Z");
const old = now - GITHUB_WEBHOOK_READ_MODEL_PAYLOAD_RETENTION_MS - 1;
const items = "github_webhook_read_model_items_v1";
const comments = "github_webhook_read_model_comments_v1";
const activity = "github_webhook_read_model_activity_v1";

function fixture() {
  const storage = new TestStorage();
  const store = new GithubWebhookReadModelStore(storage);
  store.ensureSchemaSync();
  return { storage, store };
}

function item(number: number): GithubWebhookReadModelObject {
  return {
    kind: "item",
    repository,
    number,
    itemKind: "issue",
    sourceUpdatedAt: new Date(old).toISOString(),
    snapshot: { number, state: "open", title: "retained title", body: "x".repeat(8192) },
  };
}

function comment(id: number, tombstone = false): GithubWebhookReadModelObject {
  return {
    kind: "comment",
    repository,
    number: 1,
    id,
    tombstone,
    sourceUpdatedAt: new Date(old).toISOString(),
    snapshot: { id, body: tombstone ? null : "ordinary comment" },
  };
}

function repair(
  store: GithubWebhookReadModelStore,
  objects: GithubWebhookReadModelObject[],
  at: number,
) {
  store.repair({ repository, repair_kind: "comments", objects, complete_comment_items: [1] }, at);
}

function observe(
  store: GithubWebhookReadModelStore,
  id: string,
  objects: GithubWebhookReadModelObject[],
  at: number,
) {
  return store.ingest(
    {
      version: 1,
      deliveryId: id,
      event: "issue_comment",
      action: "created",
      receivedAt: new Date(at).toISOString(),
      eventClasses: [
        "issues",
        "issue_comments",
        "pull_request_reviews",
        "pull_request_review_comments",
      ],
      objects,
    },
    at,
  );
}

function prune(storage: TestStorage, store: GithubWebhookReadModelStore) {
  return storage.transactionSync(() => store.prunePayloadsSync(now).retired);
}

test("payload expiry upgrades existing rows idempotently and uses bounded partial indexes", () => {
  const { storage, store } = fixture();
  observe(store, "old", [item(1), comment(1)], old);
  for (const table of [items, comments, activity]) {
    storage.sql.exec(`DROP INDEX ${table}_payload_retention`);
    storage.sql.exec(`ALTER TABLE ${table} DROP COLUMN payload_pruned`);
    storage.sql.exec(`ALTER TABLE ${table} DROP COLUMN payload_retire_at`);
  }
  store.ensureSchemaSync();
  store.ensureSchemaSync();
  assert.equal(
    storage.scalar(`SELECT COUNT(*) AS value FROM ${items} WHERE payload_pruned = 0`),
    1,
  );
  for (const table of [items, comments, activity]) {
    const protectedExpression =
      table === items
        ? `EXISTS (SELECT 1 FROM ${comments} c WHERE c.repository = ${table}.repository
          AND c.number = ${table}.number AND c.tombstone = 0 AND instr(c.snapshot_json, 'ClawSweeper status: review started.') > 0)`
        : table === comments
          ? "instr(snapshot_json, 'ClawSweeper status: review started.') > 0"
          : "0";
    const selector = `SELECT rowid, ${protectedExpression} AS protected FROM ${table}
      WHERE payload_pruned = 0 AND payload_retire_at >= 0 AND payload_retire_at < ?
      ${table === items ? "" : "AND tombstone = 0"} ORDER BY payload_retire_at LIMIT ?`;
    const plan = [...storage.sql.exec(`EXPLAIN QUERY PLAN ${selector}`, now, 64)]
      .map((row) => row.detail)
      .join("\n");
    assert.match(plan, new RegExp(`USING (?:COVERING )?INDEX ${table}_payload_retention`));
    assert.doesNotMatch(plan, /USE TEMP B-TREE/);
    const deadlinePlan = [
      ...storage.sql.exec(`EXPLAIN QUERY PLAN
      SELECT MIN(payload_retire_at) FROM ${table}
       WHERE payload_pruned = 0 AND payload_retire_at >= 0
         ${table === items ? "" : "AND tombstone = 0"}`),
    ]
      .map((row) => row.detail)
      .join("\n");
    assert.match(deadlinePlan, new RegExp(`USING (?:COVERING )?INDEX ${table}_payload_retention`));
  }
});

test("maintenance deadlines survive restart and exclude tombstones, protected and retired rows", () => {
  const { storage, store } = fixture();
  assert.equal(store.nextMaintenanceAtSync(), null);
  observe(store, "deadlines", [item(1), comment(1), comment(2, true)], old);
  storage.sql.exec(`UPDATE ${items} SET payload_retire_at = -1`);
  storage.sql.exec(`UPDATE ${comments} SET payload_retire_at = 50 WHERE comment_id = 1`);
  storage.sql.exec(`UPDATE ${comments} SET payload_retire_at = 0 WHERE tombstone = 1`);
  assert.equal(store.nextMaintenanceAtSync(), 50);
  const restarted = new GithubWebhookReadModelStore(storage);
  restarted.ensureSchemaSync();
  assert.equal(restarted.nextMaintenanceAtSync(), 50);
  storage.sql.exec(`UPDATE ${comments} SET payload_pruned = 1 WHERE comment_id = 1`);
  assert.equal(restarted.nextMaintenanceAtSync(), null);
});

test("payload retirement drains bounded batches, retains cutoff/fresh rows, and survives restart", () => {
  const { storage, store } = fixture();
  observe(
    store,
    "old-batch",
    Array.from({ length: 70 }, (_, index) => item(index + 1)),
    old,
  );
  observe(store, "cutoff", [item(100)], now - GITHUB_WEBHOOK_READ_MODEL_PAYLOAD_RETENTION_MS);
  assert.equal(prune(storage, store), GITHUB_WEBHOOK_READ_MODEL_PAYLOAD_PRUNE_LIMIT);
  assert.equal(
    storage.scalar(`SELECT COUNT(*) AS value FROM ${items} WHERE payload_pruned = 1`),
    64,
  );
  const restarted = new GithubWebhookReadModelStore(storage);
  restarted.ensureSchemaSync();
  assert.equal(prune(storage, restarted), 6);
  assert.equal(prune(storage, restarted), 0);
  assert.equal(
    storage.scalar(`SELECT COUNT(*) AS value FROM ${items} WHERE length(snapshot_json) > 2`),
    1,
  );
});

test("retirement preserves source ordering, GUID deduplication, real tombstones, and forces repair", async () => {
  const { storage, store } = fixture();
  observe(store, "old", [item(1), comment(1), comment(2, true)], old);
  const before = [...storage.sql.exec(`SELECT * FROM ${comments} WHERE comment_id = 2`)];
  const receipts = [...storage.sql.exec(`SELECT * FROM github_webhook_read_model_deliveries_v1`)];
  assert.equal(prune(storage, store), 2);
  assert.deepEqual([...storage.sql.exec(`SELECT * FROM ${comments} WHERE comment_id = 2`)], before);
  assert.deepEqual(
    [...storage.sql.exec(`SELECT * FROM github_webhook_read_model_deliveries_v1`)],
    receipts,
  );
  assert.equal((await store.readItem({ repository, number: 1 }, now)).usable, false);
  observe(
    store,
    "late",
    [{ ...comment(1), sourceUpdatedAt: new Date(old - 1).toISOString() }],
    now,
  );
  assert.equal(
    storage.scalar(`SELECT payload_pruned AS value FROM ${comments} WHERE comment_id = 1`),
    1,
  );
  observe(store, "fresh", [{ ...comment(3), sourceUpdatedAt: new Date(now).toISOString() }], now);
  const partial = await store.readComments({ repository, number: 1 }, now);
  assert.equal(partial.usable, false, "a fresh fragment is not a complete collection");
  assert.deepEqual(partial.tombstones, [2]);
  assert.deepEqual(observe(store, "fresh", [], now), {
    accepted: true,
    deduped: true,
    watermark: 3,
  });
  repair(
    store,
    [
      item(1),
      comment(1),
      comment(2),
      { ...comment(3), sourceUpdatedAt: new Date(now).toISOString() },
    ],
    now,
  );
  const restored = await store.readComments({ repository, number: 1 }, now);
  assert.equal(restored.usable, true);
  assert.deepEqual(restored.tombstones, [2], "equal-source repair cannot resurrect a tombstone");
  assert.equal((await store.readItem({ repository, number: 1 }, now)).usable, true);
});

test("equal-source live confirmation retains useful payloads without accepting equal webhook bytes", () => {
  const { storage, store } = fixture();
  observe(store, "old", [item(1), comment(1)], old);
  repair(store, [item(1), comment(1)], now);
  assert.equal(prune(storage, store), 0);
  observe(store, "same-source", [{ ...item(1), snapshot: { body: "wrong" } }], now);
  assert.equal(
    [...storage.sql.exec(`SELECT snapshot_json FROM ${items}`)][0].snapshot_json.includes("wrong"),
    false,
  );
});

test("ordinary retirement preserves placeholder census and rolls back collection changes on failure", async () => {
  const { storage, store } = fixture();
  observe(
    store,
    "old",
    [
      item(1),
      comment(1),
      item(2),
      {
        ...comment(2),
        number: 2,
        snapshot: { id: 2, body: "ClawSweeper status: review started." },
      },
    ],
    old,
  );
  store.repair({ repository, repair_kind: "placeholders", objects: [] }, now - 1);
  assert.equal((await store.readPlaceholders({ repository, state: "open" }, now)).usable, true);
  const before = await store.readPlaceholders({ repository, state: "open" }, now);
  storage.failNextSqlMatching(/UPDATE github_webhook_read_model_collections_v1 SET complete/);
  assert.throws(() => prune(storage, store), /injected/);
  assert.equal(storage.scalar(`SELECT SUM(payload_pruned) AS value FROM ${items}`), 0);
  assert.equal((await store.readPlaceholders({ repository, state: "open" }, now)).usable, true);
  assert.equal(prune(storage, store), 2);
  const after = await store.readPlaceholders({ repository, state: "open" }, now);
  assert.equal(after.usable, true);
  assert.deepEqual(after.candidates, before.candidates);
  store.repair(
    {
      repository,
      repair_kind: "placeholders",
      objects: [item(1), comment(1)],
      complete_comment_items: [1],
    },
    now,
  );
  const restored = await store.readPlaceholders({ repository, state: "open" }, now);
  assert.equal(restored.usable, true);
  assert.equal((restored.candidates as unknown[]).length, 1);
});

test("partial placeholder repairs cannot hide another retained unresolved placeholder", async () => {
  const { storage, store } = fixture();
  const placeholders = [2, 3].flatMap((number) => [
    item(number),
    {
      ...comment(number),
      number,
      snapshot: { id: number, body: "ClawSweeper status: review started." },
    },
  ]);
  observe(store, "old", [item(1), ...placeholders], old);
  store.repair({ repository, repair_kind: "placeholders", objects: [] }, now - 1);
  const before = await store.readPlaceholders({ repository, state: "open" }, now);
  assert.equal(prune(storage, store), 1);
  store.repair({ repository, repair_kind: "placeholders", objects: placeholders.slice(0, 2) }, now);
  const after = await store.readPlaceholders({ repository, state: "open" }, now);
  assert.equal(after.usable, true);
  assert.deepEqual(after.candidates, before.candidates);
});

test("pruned review activity cannot become a usable partial collection", async () => {
  const { storage, store } = fixture();
  const review: GithubWebhookReadModelObject = { ...comment(1), kind: "review" };
  observe(store, "old", [item(1), review], old);
  assert.equal(prune(storage, store), 2);
  observe(store, "new", [{ ...review, id: 2, sourceUpdatedAt: new Date(now).toISOString() }], now);
  const partial = await store.readActivity({ repository, number: 1 }, now);
  assert.equal(partial.usable, false);
  assert.equal((partial.reviews as unknown[]).length, 1);
});

test("retiring an item cannot erase completeness guards for fresh comment and activity fragments", async () => {
  const { storage, store } = fixture();
  const source = item(1);
  observe(
    store,
    "old-item",
    [{ ...source, snapshot: { ...source.snapshot, comments: 2, review_comments: 2 } }],
    old,
  );
  prune(storage, store);
  const current = { ...comment(1), sourceUpdatedAt: new Date(now).toISOString() };
  observe(store, "fresh-fragments", [current, { ...current, kind: "review_comment" }], now);
  assert.equal((await store.readItem({ repository, number: 1 }, now)).hit, false);
  assert.equal((await store.readComments({ repository, number: 1 }, now)).usable, false);
  assert.equal((await store.readActivity({ repository, number: 1 }, now)).usable, false);
  const partialItem = {
    ...source,
    sourceUpdatedAt: new Date(now).toISOString(),
    snapshot: { title: "new title" },
  };
  observe(store, "newer-partial-item", [partialItem], now);
  assert.equal((await store.readItem({ repository, number: 1 }, now)).hit, false);
  assert.equal((await store.readComments({ repository, number: 1 }, now)).usable, false);
  assert.equal((await store.readActivity({ repository, number: 1 }, now)).usable, false);
  repair(
    store,
    [
      { ...partialItem, snapshot: { ...source.snapshot, comments: 2, review_comments: 2 } },
      current,
    ],
    now,
  );
  assert.equal((await store.readItem({ repository, number: 1 }, now)).usable, true);
  assert.equal((await store.readComments({ repository, number: 1 }, now)).gap_detected, true);
  assert.equal((await store.readActivity({ repository, number: 1 }, now)).gap_detected, true);
});

test("protected prefixes are classified once in bounded batches and reconsidered when comments change", async () => {
  const { storage, store } = fixture();
  const placeholders = Array.from({ length: 100 }, (_, index) => {
    const number = index + 1;
    return [
      item(number),
      {
        ...comment(number),
        number,
        snapshot: { id: number, body: "ClawSweeper status: review started." },
      },
    ];
  }).flat() as GithubWebhookReadModelObject[];
  observe(
    store,
    "old-prefix",
    [...placeholders, ...Array.from({ length: 70 }, (_, index) => item(index + 101))],
    old,
  );
  assert.equal(prune(storage, store), 0);
  assert.equal(
    storage.scalar(`SELECT COUNT(*) AS value FROM ${items} WHERE payload_retire_at = -1`),
    64,
  );
  assert.equal(prune(storage, store), 28);
  assert.equal(prune(storage, store), 42);
  assert.equal(prune(storage, store), 0);
  assert.equal(prune(storage, store), 0);
  for (const table of [items, comments]) {
    assert.equal(
      storage.scalar(`SELECT COUNT(*) AS value FROM ${table} WHERE payload_retire_at = -1`),
      100,
    );
    assert.equal(
      storage.scalar(
        `SELECT COUNT(*) AS value FROM ${table} WHERE payload_pruned = 0 AND payload_retire_at = 0`,
      ),
      0,
    );
  }
  observe(
    store,
    "resolved",
    [
      {
        ...comment(1),
        sourceUpdatedAt: new Date(now).toISOString(),
        snapshot: { id: 1, body: "review complete" },
      },
    ],
    now,
  );
  assert.equal((await store.readItem({ repository, number: 1 }, now)).hit, true);
  assert.equal(
    storage.scalar(`SELECT payload_retire_at AS value FROM ${comments} WHERE comment_id = 1`),
    now + GITHUB_WEBHOOK_READ_MODEL_PAYLOAD_RETENTION_MS,
  );
  assert.equal(
    storage.scalar(`SELECT payload_retire_at AS value FROM ${items} WHERE number = 1`),
    0,
  );
  assert.equal(prune(storage, store), 0);
  assert.equal(
    storage.scalar(`SELECT payload_retire_at AS value FROM ${items} WHERE number = 1`),
    now + GITHUB_WEBHOOK_READ_MODEL_PAYLOAD_RETENTION_MS,
  );
});

test("ordinary payloads expire after a whole family is idle for the longest reader TTL", async () => {
  assert.equal(
    GITHUB_WEBHOOK_READ_MODEL_PAYLOAD_RETENTION_MS,
    GITHUB_WEBHOOK_READ_MODEL_COMMENT_TTL_MS,
  );
  const { storage, store } = fixture();
  const historical = now - 50 * 60 * 60_000;
  observe(
    store,
    "historical",
    [
      { ...item(1), snapshot: { comments: 2, review_comments: 1 } },
      comment(1),
      { ...comment(1), kind: "review_comment" },
    ],
    historical,
  );
  observe(store, "current", [{ ...comment(2), sourceUpdatedAt: new Date(now).toISOString() }], now);
  assert.equal(prune(storage, store), 0);
  assert.equal((await store.readComments({ repository, number: 1 }, now)).usable, true);
  assert.equal(
    ((await store.readComments({ repository, number: 1 }, now)).comments as unknown[]).length,
    2,
  );
  assert.equal(storage.scalar(`SELECT SUM(payload_pruned) AS value FROM ${items}`), 0);
  const boundary = now + GITHUB_WEBHOOK_READ_MODEL_PAYLOAD_RETENTION_MS;
  assert.equal(
    storage.transactionSync(() => store.prunePayloadsSync(boundary).retired),
    0,
  );
  assert.equal(
    storage.transactionSync(() => store.prunePayloadsSync(boundary + 1).retired),
    4,
  );
  assert.equal((await store.readComments({ repository, number: 1 }, boundary + 1)).usable, false);
});

test("hot prefixes are deferred once so cold families still drain in bounded passes", () => {
  const { storage, store } = fixture();
  observe(
    store,
    "old-families",
    Array.from({ length: 135 }, (_, index) => item(index + 1)),
    old,
  );
  observe(
    store,
    "active-families",
    Array.from({ length: 65 }, (_, index) => ({
      ...comment(index + 1),
      number: index + 1,
      sourceUpdatedAt: new Date(now).toISOString(),
    })),
    now,
  );
  // Ingress never scans payload families. The first alarm defers the hot prefix.
  assert.deepEqual(
    storage.transactionSync(() => store.prunePayloadsSync(now)),
    {
      scanned: 64,
      retired: 0,
      retired_bytes: 0,
      deferred: 64,
      protected: 0,
    },
  );
  assert.equal(prune(storage, store), 63);
  assert.equal(prune(storage, store), 7);
  assert.equal(prune(storage, store), 0);
  assert.equal(
    storage.scalar(`SELECT COUNT(*) AS value FROM ${items} WHERE payload_pruned = 1`),
    70,
  );
});

test("complete comment repair supersedes an older parent, including after payload retirement", async () => {
  for (const retired of [false, true]) {
    const { storage, store } = fixture();
    observe(store, "old", [{ ...item(1), snapshot: { comments: 1 } }, comment(1)], old);
    if (retired) prune(storage, store);
    const objects = [comment(1), comment(2)];
    for (let pass = 0; pass < 2; pass += 1) {
      store.repair(
        { repository, repair_kind: "comments", objects, complete_comment_items: [1] },
        now,
      );
      const result = await store.readComments({ repository, number: 1 }, now);
      assert.equal(result.usable, true);
      assert.equal((result.comments as unknown[]).length, 2);
    }
    observe(
      store,
      "new-parent",
      [{ ...item(1), sourceUpdatedAt: new Date(now).toISOString(), snapshot: { comments: 3 } }],
      now,
    );
    assert.equal((await store.readComments({ repository, number: 1 }, now)).usable, false);
    store.repair(
      { repository, repair_kind: "comments", objects, complete_comment_items: [1] },
      now,
    );
    assert.equal((await store.readComments({ repository, number: 1 }, now)).usable, true);
  }
});

test("fresh empty comment census owns freshness and retains an idle parent until it expires", async () => {
  const { storage, store } = fixture();
  observe(store, "old", [item(1), comment(1, true)], old);
  store.repair(
    { repository, repair_kind: "comments", objects: [], complete_comment_items: [1] },
    now,
  );
  assert.equal(
    storageContentPage(storage.sql, { table: items, retention: true, asOf: now }).retention!
      .eligibleRows,
    0,
  );
  assert.equal(prune(storage, store), 0);
  const result = await store.readComments({ repository, number: 1 }, now);
  assert.equal(result.usable, true);
  assert.deepEqual(result.comments, []);
  assert.deepEqual(result.tombstones, [1]);
});

test("a complete upstream census cannot certify a truncated cache", async () => {
  const { store } = fixture();
  observe(store, "parent", [{ ...item(1), snapshot: { comments: 501 } }], old);
  const full = Array.from({ length: 501 }, (_, index) => comment(index + 1));
  repair(store, full, now);
  assert.equal((await store.readComments({ repository, number: 1 }, now)).usable, false);
  repair(store, full.slice(1), now);
  assert.equal((await store.readComments({ repository, number: 1 }, now)).usable, true);
  observe(
    store,
    "overflow",
    [{ ...comment(502), sourceUpdatedAt: new Date(now).toISOString() }],
    now,
  );
  assert.equal((await store.readComments({ repository, number: 1 }, now)).usable, false);
});

test("legacy completeness receipts require fresh proof after upgrade", async () => {
  const { storage, store } = fixture();
  observe(store, "parent", [{ ...item(1), snapshot: { comments: 501 } }], old);
  const full = Array.from({ length: 501 }, (_, index) => comment(index + 1));
  repair(store, full, now);
  storage.sql.exec("ALTER TABLE github_webhook_read_model_collections_v1 DROP COLUMN complete");
  store.ensureSchemaSync();
  store.ensureSchemaSync();
  assert.equal((await store.readComments({ repository, number: 1 }, now)).usable, false);
  repair(store, full.slice(1), now);
  assert.equal((await store.readComments({ repository, number: 1 }, now)).usable, true);
});

test("bounded retirement and partial restoration cannot erase truncation evidence", async () => {
  const { storage, store } = fixture();
  observe(
    store,
    "prefix",
    Array.from({ length: 63 }, (_, index) => item(index + 2)),
    old,
  );
  const full = Array.from({ length: 501 }, (_, index) => comment(index + 1));
  repair(store, full, old);
  assert.equal(prune(storage, store), 64);
  assert.equal(storage.scalar(`SELECT SUM(payload_pruned) AS value FROM ${comments}`), 1);
  store.repair({ repository, repair_kind: "comments", objects: [comment(2)] }, now);
  assert.equal(storage.scalar(`SELECT SUM(payload_pruned) AS value FROM ${comments}`), 0);
  assert.equal((await store.readComments({ repository, number: 1 }, now)).usable, false);
  repair(store, full.slice(1), now);
  assert.equal((await store.readComments({ repository, number: 1 }, now)).usable, true);
});

test("unresolved placeholders survive beyond the live discovery lookback", async () => {
  const { storage, store } = fixture();
  const historical = now - 90 * 24 * 60 * 60_000;
  observe(
    store,
    "unresolved",
    [
      item(1),
      {
        ...comment(1),
        snapshot: {
          id: 1,
          body: "ClawSweeper status: review started.",
        },
      },
    ].map((object) => ({ ...object, sourceUpdatedAt: new Date(historical).toISOString() })),
    historical,
  );
  store.repair({ repository, repair_kind: "placeholders", objects: [] }, now);
  assert.equal(prune(storage, store), 0);
  const result = await store.readPlaceholders({ repository, state: "open" }, now);
  assert.equal(result.usable, true);
  assert.equal((result.candidates as unknown[]).length, 1);
});

test("placeholder discovery exposes missing and retired parent gaps through partial repairs", async () => {
  for (const retired of [false, true]) {
    const { storage, store } = fixture();
    if (retired) {
      observe(store, "old", [item(1)], old);
      prune(storage, store);
    }
    const updatedAt = new Date(now).toISOString();
    const marker = {
      ...comment(1),
      sourceUpdatedAt: updatedAt,
      snapshot: { id: 1, body: "ClawSweeper status: review started." },
    };
    store.repair({ repository, repair_kind: "placeholders", objects: [] }, now - 1);
    observe(store, "new-marker", [marker], now);
    for (const state of ["open", "closed", "all"]) {
      const gap = await store.readPlaceholders({ repository, state }, now);
      assert.equal(gap.usable, false);
      assert.equal(gap.gap_detected, true);
      assert.deepEqual(gap.candidates, []);
    }
    store.repair({ repository, repair_kind: "placeholders", objects: [marker] }, now);
    assert.equal((await store.readPlaceholders({ repository, state: "all" }, now)).usable, false);
    store.repair(
      {
        repository,
        repair_kind: "placeholders",
        objects: [marker, { ...item(1), sourceUpdatedAt: updatedAt }],
      },
      now,
    );
    const restored = await store.readPlaceholders({ repository, state: "all" }, now);
    assert.equal(restored.usable, true);
    assert.equal((restored.candidates as unknown[]).length, 1);
  }
});

test("retirement eligibility measures stored bytes without writes and matches the real pruner", () => {
  const { storage, store } = fixture();
  const payload = { body: "雪🦊\0" };
  observe(
    store,
    "mixed",
    Array.from({ length: 9 }, (_, index) => {
      const number = index + 1;
      return [
        item(number),
        {
          ...comment(number, number === 3),
          number,
          snapshot: [2, 9].includes(number) ? { body: STORED_JSON_PLACEHOLDER } : payload,
        },
      ];
    }).flat(),
    old,
  );
  storage.run(
    `UPDATE ${comments} SET snapshot_json=? WHERE number=2`,
    encodeStoredJson(JSON.stringify({ body: STORED_JSON_PLACEHOLDER + "雪🦊".repeat(1000) })),
  );
  storage.exec(`UPDATE ${comments} SET payload_pruned=1, snapshot_json='{}' WHERE number=4`);
  storage.exec(`UPDATE ${comments} SET payload_retire_at=-1 WHERE number=5`);
  storage.run(
    `UPDATE ${items} SET received_at=? WHERE number=6`,
    now - GITHUB_WEBHOOK_READ_MODEL_PAYLOAD_RETENTION_MS,
  );
  storage.run(`UPDATE ${comments} SET payload_retire_at=? WHERE number=7`, now);
  const tables = [items, comments, activity];
  const snapshot = () => tables.map((table) => [...storage.sql.exec(`SELECT * FROM ${table}`)]);
  const before = snapshot();
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      assert.match(query, /^\s*SELECT\b/i);
      if (query.includes("AS protected, octet_length")) {
        const plan = [...storage.sql.exec(`EXPLAIN QUERY PLAN ${query}`, ...bindings)]
          .map((row) => row.detail)
          .join("\n");
        assert.match(plan, /USING INTEGER PRIMARY KEY/);
      }
      return storage.sql.exec(query, ...bindings);
    },
  };
  const pages = tables.map((table) =>
    storageContentPage(sql, { table, retention: true, asOf: now }),
  );
  assert.deepEqual(pages[1].retention, {
    asOf: now,
    eligibleRows: 2,
    eligibleStoredBytes: 2 * Buffer.byteLength(encodeStoredJson(JSON.stringify(payload))),
  });
  assert.deepEqual(snapshot(), before);
  assert.equal(storage.scheduledAlarm(), null);
  const result = storage.transactionSync(() => store.prunePayloadsSync(now));
  const rows = pages.reduce((sum, page) => sum + page.retention!.eligibleRows, 0);
  const bytes = pages.reduce((sum, page) => sum + page.retention!.eligibleStoredBytes, 0);
  assert.equal(result.retired, rows);
  assert.equal(
    result.retired_bytes,
    bytes - rows * 2,
    "retirement leaves {} rather than deleting identities",
  );
});

test("eligibility shares fresh activity retention without protecting marker text in activity bodies", () => {
  for (const kind of ["review", "review_comment"] as const) {
    const { storage, store } = fixture();
    observe(store, "old", [item(1), comment(1)], old);
    observe(
      store,
      "fresh-activity",
      [
        {
          ...comment(2),
          kind,
          sourceUpdatedAt: new Date(now).toISOString(),
          snapshot: { body: STORED_JSON_PLACEHOLDER },
        },
      ],
      now,
    );
    for (const table of [items, comments, activity])
      assert.equal(
        storageContentPage(storage.sql, { table, retention: true, asOf: now }).retention!
          .eligibleRows,
        0,
      );
    assert.equal(prune(storage, store), 0);
    const expired = now + GITHUB_WEBHOOK_READ_MODEL_PAYLOAD_RETENTION_MS + 1;
    for (const table of [items, comments, activity])
      assert.equal(
        storageContentPage(storage.sql, { table, retention: true, asOf: expired }).retention!
          .eligibleRows,
        1,
      );
    assert.equal(storage.transactionSync(() => store.prunePayloadsSync(expired)).retired, 3);
  }
});

test("eligibility pages preserve their cutoff and frontier across gaps, growth and deletion", () => {
  const { storage, store } = fixture();
  observe(
    store,
    "pages",
    Array.from({ length: 66 }, (_, index) => item(index + 1)),
    old,
  );
  storage.exec(`DELETE FROM ${items} WHERE number=10`);
  const first = storageContentPage(storage.sql, { table: items, retention: true, asOf: now });
  assert.equal(first.scannedRows, 64);
  assert.equal(first.retention!.eligibleRows, 64);
  assert.deepEqual(first.nextCursor, {
    afterRowid: 65,
    upperRowid: 66,
    retention: true,
    asOf: now,
  });
  observe(store, "growth", [item(100)], old);
  const last = storageContentPage(storage.sql, { table: items, ...first.nextCursor });
  assert.equal(last.scannedRows, 1);
  assert.equal(last.retention!.asOf, now);
  assert.equal(last.complete, true);
  storage.exec(`DELETE FROM ${items} WHERE number=66`);
  const empty = storageContentPage(storage.sql, { table: items, ...first.nextCursor });
  assert.deepEqual(empty.retention, { asOf: now, eligibleRows: 0, eligibleStoredBytes: 0 });
  assert.equal(empty.complete, true);
});

test("eligibility rejects invalid modes, cutoffs and resumes without initializing storage", () => {
  const { storage } = fixture();
  for (const input of [
    { table: comments, retention: "true" },
    { table: comments, retention: true, asOf: -1 },
    { table: comments, retention: true, asOf: 0.5 },
    { table: comments, retention: true, afterRowid: 1, upperRowid: 9, asOf: null },
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
