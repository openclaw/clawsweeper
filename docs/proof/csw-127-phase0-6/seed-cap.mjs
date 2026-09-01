import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const [mode, databasePath, outputDir] = process.argv.slice(2);
if (!databasePath) process.exit(2);
const database = new DatabaseSync(databasePath);
const hasQueue = database
  .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
  .get("exact_review_github_egress_rollups_v2");
if (mode === "probe") {
  console.log(hasQueue ? "1" : "0");
  database.close();
  process.exit(0);
}
assert.equal(mode, "seed");
assert.ok(hasQueue, "queue telemetry schema must exist before cap seeding");
assert.ok(outputDir);

const now = Date.now();
const oldBucket = Math.floor((now - 2 * 60 * 60_000) / 300_000) * 300_000;
database.exec("BEGIN IMMEDIATE");
try {
  database.exec("DELETE FROM exact_review_github_egress_rollups_v2");
  database.exec("DELETE FROM exact_review_github_rate_limits_v2");
  database.exec("DELETE FROM exact_review_github_egress_receipts_v2");
  database.exec(`
    UPDATE exact_review_github_egress_diagnostics_v2
       SET accepted_submissions = 0,
           deduped_submissions = 0,
           rejected_submissions = 0,
           accepted_metrics = 0,
           accepted_rate_limits = 0,
           incomplete_count = 0,
           evicted_rollup_rows = 0,
           evicted_five_minute_rollup_rows = 0,
           evicted_hour_rollup_rows = 0,
           rollup_eviction_counts_exact = 1,
           evicted_rate_limit_rows = 0,
           last_rollup_evicted_at = NULL,
           last_rate_limit_evicted_at = NULL,
           last_five_minute_evicted_bucket_start = NULL,
           last_hour_evicted_bucket_start = NULL,
           last_rate_limit_evicted_observed_at = NULL,
           last_observed_at = NULL
     WHERE singleton_id = 1
  `);
  database
    .prepare(`
      WITH RECURSIVE sequence(value) AS (
        VALUES(1) UNION ALL SELECT value + 1 FROM sequence WHERE value < 50000
      )
      INSERT INTO exact_review_github_egress_rollups_v2 (
        bucket_kind, bucket_start, deployment_revision, config_revision,
        pool_class, pool_identity, stage, source_action, operation, method,
        route_template, page_bucket, unit, outcome, status_bucket,
        latency_bucket, claim_generation_bucket, first_repeat, attempted,
        telemetry_complete, count
      )
      SELECT 'five_minute', ?, 'aaaaaaaaaaaaaaaa', printf('%016x', value),
             'repository_actions', 'cccccccccccccccccccccccc', 'publication_apply',
             'scheduled_hot', 'comments', 'GET', 'issue_comments', '1',
             'wire_attempt', 'success', '2xx', '100_249ms', '1', 'first', 1, 1, 1
        FROM sequence
    `)
    .run(oldBucket);
  database
    .prepare(`
      WITH RECURSIVE sequence(value) AS (
        VALUES(1) UNION ALL SELECT value + 1 FROM sequence WHERE value < 10000
      )
      INSERT INTO exact_review_github_rate_limits_v2 (
        event_id, observed_at, deployment_revision, config_revision,
        pool_class, pool_identity, stage, source_action, operation, method,
        route_template, page_bucket, status, retry_after_present, retry_after_seconds,
        limit_present, rate_limit, remaining_present, remaining, used_present, used,
        reset_present, reset_epoch_seconds, resource_present, resource,
        reset_authority_candidate, telemetry_complete
      )
      SELECT printf('%064x', value), ?, 'aaaaaaaaaaaaaaaa', printf('%016x', value),
             'target_app', 'dddddddddddddddddddddddd', 'publication_apply',
             'scheduled_hot', 'item_metadata', 'GET', 'issue_metadata', '1', 403,
             0, NULL, 1, 5000, 1, 10, 1, 4990, 1, ?, 1, 'core',
             'rate_limit_reset', 1
        FROM sequence
    `)
    .run(oldBucket, Math.floor((oldBucket + 60_000) / 1000));
  database.exec("COMMIT");
} catch (error) {
  database.exec("ROLLBACK");
  throw error;
}

const rollups = Number(
  database.prepare("SELECT COUNT(*) AS count FROM exact_review_github_egress_rollups_v2").get()
    .count,
);
const rateLimits = Number(
  database.prepare("SELECT COUNT(*) AS count FROM exact_review_github_rate_limits_v2").get().count,
);
assert.equal(rollups, 50_000);
assert.equal(rateLimits, 10_000);
const receipt = {
  old_bucket_start: new Date(oldBucket).toISOString(),
  rollup_rows: rollups,
  rate_limit_rows: rateLimits,
};
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(
  path.join(outputDir, "seed-receipt.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
);
console.log(JSON.stringify(receipt));
database.close();
