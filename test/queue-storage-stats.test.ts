import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { storageStats } from "../dashboard/storage-stats.ts";
import {
  ExactReviewQueue,
  MemoryDurableNamespace,
  MemoryDurableStorage,
  signedStateAppendRequest,
  stateAppendQueueRequest,
  test,
  worker,
} from "./dashboard-worker-harness.ts";

const sqlOver = (database: DatabaseSync) => ({
  exec: (query: string, ...bindings: unknown[]) =>
    database.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[],
});

test("storage stats count encoded content bytes without treating them as physical allocation", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`CREATE TABLE mixed (
      text TEXT, payload BLOB, whole INTEGER, fraction REAL, absent TEXT
    ) STRICT`);
    database.exec(`CREATE TABLE compact (
      text TEXT PRIMARY KEY, payload BLOB, whole INTEGER, fraction REAL, absent TEXT
    ) WITHOUT ROWID`);
    for (const table of ["mixed", "compact"]) {
      database
        .prepare(`INSERT INTO ${table} VALUES (?, ?, ?, ?, ?)`)
        .run("é🦊\0尾", new Uint8Array([0, 255, 65]), -1234, 1.25, null);
    }
    const allocatedBytes = () =>
      Number(database.prepare("PRAGMA page_count").get()!.page_count) *
      Number(database.prepare("PRAGMA page_size").get()!.page_size);
    const before = allocatedBytes();
    const stats = storageStats({ ...sqlOver(database), databaseSize: before });

    // 10 encoded text bytes + 3 BLOB bytes + 5 integer characters + 4 real characters.
    // NULL contributes zero; neither the NUL nor the three-byte character after it is lost.
    assert.deepEqual(
      stats.tables.map(({ table, rows, sampledRows, averageRowBytes, estimatedBytes }) => ({
        table,
        rows,
        sampledRows,
        averageRowBytes,
        estimatedBytes,
      })),
      ["compact", "mixed"].map((table) => ({
        table,
        rows: 1,
        sampledRows: 1,
        averageRowBytes: 22,
        estimatedBytes: 22,
      })),
    );
    assert.equal(stats.estimatedTableBytes, 44);
    assert.equal(stats.databaseBytes, before);
    assert.ok(stats.databaseBytes > stats.estimatedTableBytes);
    assert.equal(allocatedBytes(), before);
  } finally {
    database.close();
  }
});

test("storage stats rank tables by estimated size from counts and a sample of both ends", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE growing (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT`);
  database.exec(
    `CREATE TABLE compact (key TEXT PRIMARY KEY, value INTEGER NOT NULL) WITHOUT ROWID`,
  );
  const insert = database.prepare(`INSERT INTO growing (body) VALUES (?)`);
  // 500 small old rows, then 500 large new rows: sampling only the oldest would miss the growth.
  for (let index = 0; index < 500; index++) insert.run("a".repeat(10));
  for (let index = 0; index < 500; index++) insert.run("b".repeat(1_000));
  database.prepare(`INSERT INTO compact (key, value) VALUES (?, ?)`).run("k", 1);

  const stats = storageStats(sqlOver(database));

  assert.deepEqual(
    stats.tables.map((table) => [table.table, table.rows, table.sampledRows]),
    [
      ["growing", 1_000, 200],
      ["compact", 1, 1],
    ],
  );
  const growing = stats.tables[0]!;
  // Half the sample is 10-byte bodies, half 1,000-byte bodies, plus the 3-digit id column.
  assert.ok(
    growing.averageRowBytes > 400 && growing.averageRowBytes < 600,
    String(growing.averageRowBytes),
  );
  assert.equal(growing.estimatedBytes, growing.rows * growing.averageRowBytes);
  assert.equal(stats.databaseBytes, null);
});

test("queue storage stats are served only to signed internal requests", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const secret = "storage-stats-secret";
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const path = "/internal/exact-review/storage-stats";
  const cleanup = {
    retired: 2,
    retiredBytes: 42,
    completedAt: 123,
    unresolved: 0,
    blockedAt: null,
  };
  storage.kv.put("record-hydration-cache-cleanup:v1", cleanup);

  const unsigned = await worker.fetch(
    stateAppendQueueRequest(path, {}, "https://clawsweeper.openclaw.ai"),
    env,
  );
  assert.equal(unsigned.status, 401);

  const signed = await worker.fetch(signedStateAppendRequest(path, {}, secret), env);
  assert.equal(signed.status, 200);
  const body = (await signed.json()) as {
    ok: boolean;
    storage: { tables: { table: string; rows: number }[] };
    hydrationCacheCleanup: typeof cleanup;
  };
  assert.equal(body.ok, true);
  assert.deepEqual(body.hydrationCacheCleanup, cleanup);
  // The report lists exactly the tables the store holds, with their row counts.
  assert.deepEqual(
    body.storage.tables.map((table) => [table.table, table.rows]),
    storageStats(storage.sql).tables.map((table) => [table.table, table.rows]),
  );

  storage.sql.exec("CREATE TABLE census_test (body TEXT, n INTEGER)");
  storage.sql.exec("INSERT INTO census_test VALUES (?, ?)", "雪🦊\0", 123);
  const census = await worker.fetch(
    signedStateAppendRequest(path, { census: { table: "census_test" } }, secret),
    env,
  );
  assert.equal(census.status, 200);
  const page = (await census.json()).census;
  assert.deepEqual(page.columns, { body: 8, n: 0 });
  assert.equal(page.scannedRows, 1);
  assert.equal(page.complete, true);
  const invalid = await worker.fetch(
    signedStateAppendRequest(path, { census: { table: "__cf_kv" } }, secret),
    env,
  );
  assert.equal(invalid.status, 400);
});
