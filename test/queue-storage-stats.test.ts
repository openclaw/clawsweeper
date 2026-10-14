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
});
