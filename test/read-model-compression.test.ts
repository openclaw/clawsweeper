import assert from "node:assert/strict";
import test from "node:test";
import {
  ReadModelCompressionStore,
  READ_MODEL_COMPRESSION_TABLES,
  ReadModelCompressionConflictError,
} from "../dashboard/read-model-compression.ts";
import {
  decodeStoredJson,
  encodeStoredJson,
  STORED_JSON_MAX_BYTES,
  STORED_JSON_PREFIX,
} from "../dashboard/stored-json.ts";
import { TestStorage } from "./exact-review-test-storage.ts";

function fixture() {
  const storage = new TestStorage();
  for (const [table, column] of READ_MODEL_COMPRESSION_TABLES)
    storage.exec(
      `CREATE TABLE ${table} (${column} TEXT NOT NULL, revision INTEGER, tombstone INTEGER, updated_at INTEGER)`,
    );
  return { storage, store: new ReadModelCompressionStore(storage) };
}
const text = ` {"legacy": "${"漢🦊\\u001b".repeat(500)}", "version": 1, "inlineProof": {"keep":"all bytes"}}\n`;

test("bounded migration preserves every text byte and metadata across mixed tables and restart", async () => {
  const { storage, store } = fixture();
  for (const [table] of READ_MODEL_COMPRESSION_TABLES) {
    for (const raw of [text, "{}", encodeStoredJson(text), "malformed legacy JSON"])
      storage.run(`INSERT INTO ${table} VALUES (?,7,1,123)`, raw);
  }
  const preview = await store.preview("a".repeat(40));
  const before = READ_MODEL_COMPRESSION_TABLES.map(([table]) => [
    ...storage.sql.exec(`SELECT rowid,* FROM ${table}`),
  ]);
  const result = store.commit(store.prepare(), 100);
  assert.equal(result.completedAt, 100);
  assert.equal(result.converted, 5);
  assert.equal(result.scanned, 20);
  assert.ok(result.savedBytes > 0);
  for (const [index, [table, column]] of READ_MODEL_COMPRESSION_TABLES.entries()) {
    const after = [...storage.sql.exec(`SELECT rowid,* FROM ${table}`)];
    after.forEach((row, n) =>
      assert.deepEqual(
        { ...row, [column]: decodeStoredJson(String(row[column])) },
        { ...before[index]![n], [column]: decodeStoredJson(String(before[index]![n]![column])) },
      ),
    );
  }
  const restart = new ReadModelCompressionStore(storage);
  assert.deepEqual(restart.commit(restart.prepare(), 200), result);
  assert.equal(
    (await restart.preview("b".repeat(40))).observedUpperRowids.join(),
    preview.observedUpperRowids.join(),
  );
});

test("row and source budgets inspect metadata before oversized payloads and make forward progress", () => {
  const { storage, store } = fixture();
  const [table, column] = READ_MODEL_COMPRESSION_TABLES[0];
  storage.run(`INSERT INTO ${table} VALUES (?,1,0,1)`, "x".repeat(STORED_JSON_MAX_BYTES + 1));
  const raw = "a".repeat(3 * 1024 * 1024);
  for (let n = 0; n < 66; n++)
    storage.run(`INSERT INTO ${table} VALUES (?,1,0,1)`, n < 3 ? raw : "{}");
  const originalExec = storage.sql.exec;
  let oversizedRead = false;
  storage.sql.exec = (query, ...args) => {
    if (query.startsWith(`SELECT ${column} AS text`) && args[0] === 1) oversizedRead = true;
    return originalExec(query, ...args);
  };
  let result = store.commit(store.prepare(), 100);
  assert.equal(oversizedRead, false);
  assert.equal(result.oversized, 1);
  assert.equal(result.scanned, 3);
  assert.equal(result.sourceBytes, 6 * 1024 * 1024);
  result = store.commit(store.prepare(), 101);
  assert.equal(result.scanned, 67);
  assert.equal(result.completedAt, null);
  result = store.commit(store.prepare(), 102);
  assert.equal(result.completedAt, 102);
});

test("CAS conflict stops before changed row, checkpoint rollback is atomic, and deletion resumes", () => {
  const { storage, store } = fixture();
  const [table, column] = READ_MODEL_COMPRESSION_TABLES[0];
  for (let n = 0; n < 3; n++) storage.run(`INSERT INTO ${table} VALUES (?,1,0,1)`, text);
  const pass = store.prepare();
  storage.run(`UPDATE ${table} SET ${column} = ? WHERE rowid = 2`, text + " ");
  const first = store.commit(pass, 100);
  assert.equal(first.afterRowid, 1);
  assert.equal(first.conflicts, 1);
  assert.equal(first.completedAt, null);
  const next = store.prepare();
  storage.failNextSqlMatching(new RegExp(`UPDATE ${table}`));
  assert.throws(() => store.commit(next, 101), /injected/);
  assert.deepEqual(store.checkpoint(), first);
  storage.run(`DELETE FROM ${table} WHERE rowid = 2`);
  assert.equal(store.commit(next, 102).completedAt, null);
  assert.equal(store.commit(store.prepare(), 103).completedAt, 103);
  assert.throws(() => store.commit(pass, 104), ReadModelCompressionConflictError);
  assert.ok(
    String(
      [...storage.sql.exec(`SELECT ${column} AS text FROM ${table} WHERE rowid=3`)][0]!.text,
    ).startsWith(STORED_JSON_PREFIX),
  );
});

test("first committed pass includes raw inserts after preview, then retains its fixed frontier", async () => {
  const { storage, store } = fixture();
  const [table, column] = READ_MODEL_COMPRESSION_TABLES[0];
  storage.run(`INSERT INTO ${table} VALUES (?,1,0,1)`, text);
  const preview = await store.preview("a".repeat(40));
  storage.run(`INSERT INTO ${table} VALUES (?,1,0,1)`, text);
  assert.equal((await store.preview("a".repeat(40))).sha256, preview.sha256);
  assert.equal(store.commit(store.prepare(), 1).scanned, 2);
  storage.run(`INSERT INTO ${table} VALUES (?,1,0,1)`, text);
  assert.deepEqual(
    new ReadModelCompressionStore(storage).checkpoint()!.upperRowids,
    [2, 0, 0, 0, 0],
  );
  assert.equal(store.commit(store.prepare(), 2).scanned, 2);
  assert.equal(
    [...storage.sql.exec(`SELECT ${column} AS text FROM ${table} WHERE rowid=3`)][0]!.text,
    text,
  );
});
