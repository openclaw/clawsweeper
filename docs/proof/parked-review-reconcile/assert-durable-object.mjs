#!/usr/bin/env node

import { DatabaseSync } from "node:sqlite";

const databasePath = process.argv[2];
if (!databasePath) throw new Error("usage: assert-durable-object.mjs <sqlite-path>");

const database = new DatabaseSync(databasePath, { readOnly: true });
try {
  const row = database
    .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("exact_review_queue_parked_actions");
  process.stdout.write(String(Number(row?.count || 0)));
} finally {
  database.close();
}
