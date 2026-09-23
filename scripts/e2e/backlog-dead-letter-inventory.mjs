#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExactReviewQueue,
  MemoryDurableStorage,
  leasedExactReviewPublicationItem,
} from "../../test/dashboard-worker-harness.ts";

// The production queue handler runs against a native, file-backed SQLite adapter.
// Cloudflare scheduling/KV are local adapters; no hosted bindings or GitHub calls.
const root = mkdtempSync(join(tmpdir(), "backlog-inventory-proof-"));
try {
  const storage = new MemoryDurableStorage(join(root, "queue.sqlite"));
  const item = leasedExactReviewPublicationItem(792, "7920");
  Object.assign(item, {
    attempts: 2,
    publicationFailureAttempts: 2,
    firstFailureAt: Date.now() - 360_000,
  });
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, { EXACT_REVIEW_RETRY_POLICY_EPOCH: "2" });
  const post = (path, body) =>
    queue.fetch(
      new Request(`https://queue/${path}`, { method: "POST", body: JSON.stringify(body) }),
    );
  assert.deepEqual(
    await (
      await post("complete", {
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "permanent_failure",
        reason_code: "invalid_artifact",
      })
    ).json(),
    { ok: true, requeued: false },
  );
  for (let n = 0; n < 1000; n++)
    storage.sql.exec(
      "INSERT INTO exact_review_queue_items (item_key,item_json) VALUES (?,?)",
      `unrelated-${n}`,
      JSON.stringify({ key: `unrelated-${n}`, payload: "x".repeat(32_768) }),
    );
  const observations = [];
  for (const [key, expected] of [
    [null, "eligible"],
    [item.key, "publication_item_active"],
    ["openclaw/openclaw#792", "fresh_review_already_active"],
  ]) {
    if (key)
      storage.sql.exec(
        "INSERT INTO exact_review_queue_items (item_key,item_json) VALUES (?,?)",
        key,
        JSON.stringify({ key }),
      );
    storage.sql.resetQueryHistory();
    const response = await post("dead-letters/list", { limit: 10 });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.dead_letters[0].fresh_recovery.reason, expected);
    assert.equal(storage.sql.queriesMatching(/SELECT item_key, item_json/).length, 0);
    const reads = storage.sql.queriesMatching(/SELECT item_key FROM exact_review_queue_items/);
    assert.equal(reads.length, 1);
    assert.equal(JSON.parse(reads[0].bindings[0]).length, 2);
    observations.push({ reason: expected, membershipKeys: 2, activePayloadScans: 0 });
    if (key) storage.sql.exec("DELETE FROM exact_review_queue_items WHERE item_key=?", key);
  }
  console.log(
    JSON.stringify(
      {
        provider: "local-native-sqlite",
        unrelatedRows: 1000,
        unrelatedPayloadBytes: 32_768_000,
        observations,
        limits:
          "Native SQLite plus production handler; Cloudflare platform failures are not reproduced.",
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
