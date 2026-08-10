import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const [databasePath, command = "table-present"] = process.argv.slice(2);
if (!databasePath) {
  throw new Error(
    "usage: assert-durable-object.mjs <database-path> [table-present|canonical-namespace]",
  );
}

const database = new DatabaseSync(databasePath);
try {
  if (command === "table-present") {
    const row = database
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'exact_review_direct_publication_plans'",
      )
      .get();
    console.log(row.count);
  } else if (command === "canonical-namespace") {
    const lowerSlug = "steipete-codexbar";
    const upperSlug = "steipete-CodexBar";
    const itemId = 2516;
    const canonical = database
      .prepare(
        `SELECT content, deleted FROM exact_review_canonical_records
          WHERE repo_slug = ? AND section = 'items' AND item_id = ?`,
      )
      .get(lowerSlug, itemId);
    const counts = database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM exact_review_canonical_records
             WHERE repo_slug = ?) AS lower_canonical_count,
           (SELECT COUNT(*) FROM exact_review_record_export_index
             WHERE repo_slug = ?) AS lower_export_count,
           (SELECT COUNT(*) FROM exact_review_canonical_records
             WHERE repo_slug = ?) AS upper_canonical_count,
           (SELECT COUNT(*) FROM exact_review_record_export_index
             WHERE repo_slug = ?) AS upper_export_count`,
      )
      .get(lowerSlug, lowerSlug, upperSlug, upperSlug);
    const receipt = database
      .prepare(
        `SELECT operations_json FROM exact_review_direct_publication_plans
          WHERE canonical_target_key = 'steipete/CodexBar#2516' AND revision = 1`,
      )
      .get();
    const operations = JSON.parse(String(receipt?.operations_json || "[]"));

    assert.equal(canonical?.content, "x");
    assert.equal(canonical?.deleted, 0);
    assert.ok(Number(counts.lower_canonical_count) > 0);
    assert.ok(Number(counts.lower_export_count) > 0);
    assert.equal(counts.upper_canonical_count, 0);
    assert.equal(counts.upper_export_count, 0);
    assert.equal(operations[0]?.path, "records/steipete-codexbar/items/2516.md");
    assert.equal(
      operations.some((operation) => operation.path.includes("steipete-CodexBar")),
      false,
    );
    console.log(
      JSON.stringify(
        {
          lowerSlug,
          lowerCanonicalRead: canonical.content,
          lowerCanonicalCount: Number(counts.lower_canonical_count),
          lowerExportCount: Number(counts.lower_export_count),
          upperSlug,
          upperCanonicalCount: Number(counts.upper_canonical_count),
          upperExportCount: Number(counts.upper_export_count),
          receiptPath: operations[0].path,
        },
        null,
        2,
      ),
    );
  } else {
    throw new Error(`unknown assertion command: ${command}`);
  }
} finally {
  database.close();
}
