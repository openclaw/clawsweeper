import { DatabaseSync } from "node:sqlite";

const [operation, databasePath] = process.argv.slice(2);
if (!operation || !databasePath) {
  throw new Error("usage: sqlite-proof.mjs <operation> <database-path>");
}

const database = new DatabaseSync(databasePath);

try {
  switch (operation) {
    case "has-run-table": {
      const row = database
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'exact_review_run_telemetry'",
        )
        .get();
      console.log(row.count);
      break;
    }
    case "seed-legacy-schema":
      database.exec(`
        CREATE TABLE exact_review_review_telemetry (
          repo TEXT NOT NULL,
          item_number INTEGER NOT NULL,
          run_id TEXT NOT NULL,
          run_attempt INTEGER NOT NULL,
          status TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          record_json TEXT NOT NULL,
          PRIMARY KEY (repo, item_number, run_id, run_attempt)
        ) STRICT;
        CREATE INDEX exact_review_review_telemetry_status
          ON exact_review_review_telemetry (status, updated_at);
        CREATE INDEX exact_review_review_telemetry_aggregate
          ON exact_review_review_telemetry (repo, updated_at);
        CREATE INDEX exact_review_review_telemetry_operation
          ON exact_review_review_telemetry (run_id, run_attempt);
        INSERT INTO exact_review_review_telemetry
          (repo, item_number, run_id, run_attempt, status, updated_at, record_json)
        VALUES ('openclaw/openclaw', 674, '67400', 1, 'completed', 1, '{}');
      `);
      break;
    case "list-retired-schema": {
      const rows = database
        .prepare(
          "SELECT type || ':' || name AS entry FROM sqlite_master WHERE name LIKE 'exact_review_review_telemetry%' ORDER BY type, name",
        )
        .all();
      for (const row of rows) console.log(row.entry);
      break;
    }
    case "count-proof-run-record": {
      const row = database
        .prepare(
          "SELECT COUNT(*) AS count FROM exact_review_run_telemetry WHERE run_id = '9900001' AND run_attempt = 1",
        )
        .get();
      console.log(row.count);
      break;
    }
    default:
      throw new Error(`unknown operation: ${operation}`);
  }
} finally {
  database.close();
}
