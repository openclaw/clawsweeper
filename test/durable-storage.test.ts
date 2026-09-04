import assert from "node:assert/strict";
import test from "node:test";

import { sqlColumnNames, type DurableStorage } from "../dashboard/durable-storage.ts";

test("SQL column names preserve query, coercion, Set order, and errors", () => {
  const calls: unknown[][] = [];
  const error = new Error("inventory failed");
  let failed = false;
  const storage = {
    sql: {
      exec: (...args: unknown[]) => {
        calls.push(args);
        if (failed) throw error;
        return [{ name: "second" }, { name: 0 }, { name: "first" }, { name: "second" }];
      },
    },
  } as DurableStorage;

  assert.deepEqual([...sqlColumnNames(storage, "example_table")], ["second", "", "first"]);
  assert.deepEqual(calls, [["SELECT name FROM pragma_table_info('example_table')"]]);
  failed = true;
  assert.throws(
    () => sqlColumnNames(storage, "example_table"),
    (thrown) => thrown === error,
  );
});
