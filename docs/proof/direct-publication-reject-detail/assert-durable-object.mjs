import { DatabaseSync } from "node:sqlite";

const [databasePath] = process.argv.slice(2);
if (!databasePath) throw new Error("usage: assert-durable-object.mjs <database-path>");

const database = new DatabaseSync(databasePath);
try {
  const row = database
    .prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'exact_review_direct_publication_plans'",
    )
    .get();
  console.log(row.count);
} finally {
  database.close();
}
