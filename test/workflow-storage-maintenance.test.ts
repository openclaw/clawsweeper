import assert from "node:assert/strict";
import test from "node:test";
import { GithubWebhookReadModelStore } from "../dashboard/github-webhook-read-model.ts";
import { storageContentPage } from "../dashboard/storage-stats.ts";
import { TestStorage } from "./exact-review-test-storage.ts";

test("coverage expiry is indexed, bounded, transactional and preserves fresh/census rows", () => {
  const storage = new TestStorage();
  let store = new GithubWebhookReadModelStore(storage);
  store.ensureSchemaSync();
  const table = "github_webhook_read_model_workflow_coverage_v1";
  const now = 1_000_000;
  const put = (kind: string, id: number, at: number) =>
    storage.sql.exec(`INSERT INTO ${table} VALUES ('example/project', ?, ?, ?, 1)`, kind, id, at);
  for (let id = 1; id <= 257; id++) put(id % 2 ? "run_jobs_v2" : "run_jobs", id, now - 300_000);
  put("run_jobs_v2", 258, now - 299_999);
  put("run_census", 0, 0);
  put("future_kind", 0, 0);
  assert.equal(store.nextMaintenanceAtSync(), now);
  const before = Array.from(storage.sql.exec(`SELECT * FROM ${table}`));
  assert.throws(
    () =>
      storage.transactionSync(() => {
        store.pruneWorkflowCoverageSync(now);
        throw new Error("rollback");
      }),
    /rollback/,
  );
  assert.deepEqual(Array.from(storage.sql.exec(`SELECT * FROM ${table}`)), before);
  assert.equal(store.pruneWorkflowCoverageSync(now), 256);
  store = new GithubWebhookReadModelStore(storage);
  store.ensureSchemaSync();
  assert.equal(store.nextMaintenanceAtSync(), now);
  assert.equal(store.pruneWorkflowCoverageSync(now), 1);
  assert.equal(store.nextMaintenanceAtSync(), now + 1);
  assert.equal(store.pruneWorkflowCoverageSync(now), 0);
  assert.equal(store.pruneWorkflowCoverageSync(now + 1), 1);
  assert.equal(store.nextMaintenanceAtSync(), null);
  assert.deepEqual(
    Array.from(
      storage.sql.exec(`SELECT coverage_kind FROM ${table} ORDER BY coverage_kind`),
      (row) => row.coverage_kind,
    ),
    ["future_kind", "run_census"],
  );
  const plan = JSON.stringify(
    Array.from(
      storage.sql.exec(
        `EXPLAIN QUERY PLAN SELECT rowid FROM ${table}
      WHERE coverage_kind IN ('run_jobs', 'run_jobs_v2') AND repaired_at <= ?
      ORDER BY repaired_at LIMIT 256`,
        now,
      ),
    ),
  );
  assert.match(plan, /workflow_coverage_expiry_v1/);
  assert.doesNotMatch(plan, /TEMP B-TREE/);
});

test("content census counts bounded UTF8/blob bytes, gaps and fixed growth boundary", () => {
  const storage = new TestStorage();
  storage.exec('CREATE TABLE "sample table" (body TEXT, payload BLOB, n INTEGER)');
  for (let id = 1; id <= 130; id++)
    storage.run(
      'INSERT INTO "sample table"(rowid, body, payload, n) VALUES (?,?,?,?)',
      id * 2,
      id === 130 ? "雪🦊\0".repeat(10000) : "a",
      new Uint8Array([1, 2]),
      123,
    );
  const first = storageContentPage(storage.sql, { table: "sample table" });
  assert.equal(first.scannedRows, 128);
  assert.deepEqual(first.columns, { body: 128, payload: 256, n: 0 });
  assert.deepEqual(first.nextCursor, { afterRowid: 256, upperRowid: 260 });
  storage.run('INSERT INTO "sample table" VALUES (?,?,?)', "later", null, 0);
  const last = storageContentPage(storage.sql, { table: "sample table", ...first.nextCursor });
  assert.equal(last.scannedRows, 2);
  assert.deepEqual(last.columns, { body: 80001, payload: 4, n: 0 });
  assert.equal(last.complete, true);
  storage.exec('DELETE FROM "sample table" WHERE rowid > 256');
  const empty = storageContentPage(storage.sql, { table: "sample table", ...first.nextCursor });
  assert.equal(empty.scannedRows, 0);
  assert.equal(empty.complete, true);
  assert.deepEqual(empty.columns, { body: 0, payload: 0, n: 0 });
});

test("content census rejects unsafe tables and cursors instead of scanning them", () => {
  const storage = new TestStorage();
  storage.exec("CREATE TABLE ordinary (body TEXT)");
  storage.exec("CREATE TABLE compact (id TEXT PRIMARY KEY) WITHOUT ROWID");
  storage.exec("CREATE TABLE _cf_private (body TEXT)");
  storage.exec("CREATE TABLE __cf_kv (body TEXT)");
  for (const table of [
    "missing",
    "sqlite_master",
    "_cf_private",
    "__cf_kv",
    "ordinary; DROP TABLE ordinary",
  ]) {
    assert.throws(() => storageContentPage(storage.sql, { table }), /invalid_storage_census_table/);
  }
  assert.throws(() => storageContentPage(storage.sql, { table: "compact" }), /requires_rowid/);
  storage.exec(
    `CREATE TABLE wide (${Array.from({ length: 99 }, (_, i) => `c${i} TEXT`).join(",")})`,
  );
  assert.throws(
    () => storageContentPage(storage.sql, { table: "wide" }),
    /invalid_storage_census_columns/,
  );
  for (const cursor of [
    { afterRowid: -1 },
    { afterRowid: 1 },
    { afterRowid: "0" },
    { upperRowid: -1 },
    { upperRowid: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(
      () => storageContentPage(storage.sql, { table: "ordinary", ...cursor }),
      /cursor/,
    );
  }
  storage.exec("INSERT INTO ordinary(rowid,body) VALUES(-1, 'negative')");
  assert.throws(() => storageContentPage(storage.sql, { table: "ordinary" }), /cursor/);
});
