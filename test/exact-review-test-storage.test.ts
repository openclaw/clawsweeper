import assert from "node:assert/strict";
import test from "node:test";
import { TestStorage } from "./exact-review-test-storage.ts";

test("TestStorage commits SQL and synchronous KV together", () => {
  const storage = new TestStorage();
  storage.exec("CREATE TABLE fixture (key TEXT PRIMARY KEY, value INTEGER)");
  const result = storage.transactionSync(() => {
    storage.sql.exec("INSERT INTO fixture VALUES ('created', 1)");
    storage.kv.put("created", { nested: { value: 1 } });
    return "committed";
  });
  assert.equal(result, "committed");
  assert.equal(storage.scalar("SELECT value FROM fixture WHERE key = 'created'"), 1);
  assert.deepEqual(storage.kv.get("created"), { nested: { value: 1 } });
});

test("TestStorage rolls back SQL and cloned KV insert, update, and delete", () => {
  const storage = new TestStorage();
  storage.exec("CREATE TABLE fixture (key TEXT PRIMARY KEY, value INTEGER)");
  for (const key of ["updated", "deleted", "nested"]) {
    storage.sql.exec("INSERT INTO fixture VALUES (?, 1)", key);
    storage.kv.put(key, { nested: { value: 1 } });
  }
  const failure = new Error("abort accepted transaction");
  assert.throws(
    () =>
      storage.transactionSync(() => {
        storage.sql.exec("INSERT INTO fixture VALUES ('created', 2)");
        storage.sql.exec("UPDATE fixture SET value = 2 WHERE key = 'updated'");
        storage.sql.exec("DELETE FROM fixture WHERE key = 'deleted'");
        storage.kv.put("created", { nested: { value: 2 } });
        storage.kv.put("updated", { nested: { value: 2 } });
        storage.kv.delete("deleted");
        (storage.kv.get("nested") as { nested: { value: number } }).nested.value = 2;
        throw failure;
      }),
    (error) => error === failure,
  );
  assert.equal(storage.scalar("SELECT COUNT(*) AS value FROM fixture"), 3);
  for (const key of ["updated", "deleted", "nested"]) {
    assert.deepEqual(
      Array.from(storage.sql.exec("SELECT value FROM fixture WHERE key = ?", key), (row) => ({
        ...row,
      })),
      [{ value: 1 }],
    );
    assert.deepEqual(storage.kv.get(key), { nested: { value: 1 } });
  }
  assert.equal(storage.kv.get("created"), undefined);
});

test("TestStorage consumes an injected failure while rolling back its transaction", () => {
  const storage = new TestStorage();
  storage.exec("CREATE TABLE fixture (value INTEGER)");
  const write = () =>
    storage.transactionSync(() => {
      storage.kv.put("credit", 1);
      storage.sql.exec("INSERT INTO fixture VALUES (1)");
    });
  storage.failNextSqlMatching(/INSERT INTO fixture/);
  assert.throws(write, /injected telemetry state write failure/);
  assert.equal(storage.kv.get("credit"), undefined);
  assert.equal(storage.scalar("SELECT COUNT(*) AS value FROM fixture"), 0);
  write();
  assert.equal(storage.kv.get("credit"), 1);
  assert.equal(storage.scalar("SELECT COUNT(*) AS value FROM fixture"), 1);
});
