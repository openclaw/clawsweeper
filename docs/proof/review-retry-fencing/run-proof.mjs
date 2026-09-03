import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  ExactReviewQueue,
  MemoryDurableStorage,
  leasedExactReviewQueueItem,
} from "../../../test/dashboard-worker-harness.ts";

const outputPath = process.env.REVIEW_RETRY_FENCING_PROOF_OUTPUT;
if (!outputPath) throw new Error("REVIEW_RETRY_FENCING_PROOF_OUTPUT is required");

const source = {
  sourceHeadSha: "a".repeat(40),
  sourceBaseSha: "b".repeat(40),
  sourceIsDraft: false,
  sourceContentRevision: "c".repeat(64),
  sourceUpdatedAt: "2026-09-03T00:00:00.000Z",
};
const item = leasedExactReviewQueueItem(1366, "91366");
item.decision = {
  ...item.decision,
  itemKind: "pull_request",
  sourceEvent: "pull_request",
  ...source,
};
item.leaseDecision = { ...item.decision };
item.state = "parked";
item.parkedReason = "review_retry_exhausted";
item.parkedRecoveryAttempts = 3;
item.parkedRecoveryAt = undefined;
item.attempts = 8;
item.reviewFailureAttempts = 8;
item.reviewRetryPolicyEpoch = "1";
item.updatedAt = Date.parse("2026-09-03T00:30:00.000Z");

const storage = new MemoryDurableStorage();
await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
const queue = new ExactReviewQueue(
  { storage },
  { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0", EXACT_REVIEW_RETRY_POLICY_EPOCH: "1" },
);
const recover = (idempotencyKey, overrides = {}, options = {}) =>
  queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/parked-reviews/recover-fresh", {
      method: "POST",
      body: JSON.stringify({
        items: [
          {
            item_key: item.key,
            revision: 1,
            updated_at_ms: item.updatedAt,
            source_head_sha: source.sourceHeadSha,
            source_base_sha: source.sourceBaseSha,
            source_is_draft: source.sourceIsDraft,
            source_content_revision: source.sourceContentRevision,
            source_updated_at: source.sourceUpdatedAt,
            ...overrides,
          },
        ],
        idempotency_key: idempotencyKey,
        ...options,
      }),
    }),
  );

const unchanged = await recover("proof:unchanged");
assert.equal(unchanged.status, 200);
assert.deepEqual(await unchanged.json(), {
  ok: true,
  recovered: 0,
  deduped: 0,
  skipped: 1,
  unchanged: 1,
});
let state = await storage.get("exact-review-queue");
assert.equal(state.items[item.key].state, "parked");
assert.equal(state.items[item.key].revision, 1);
assert.equal(state.items[item.key].parkedRecoveryAttempts, 3);
assert.equal(state.items[item.key].reviewFailureAttempts, 8);

const changedHead = "d".repeat(40);
const changed = await recover("proof:changed-head", { source_head_sha: changedHead });
assert.equal(changed.status, 200);
assert.deepEqual(await changed.json(), {
  ok: true,
  recovered: 1,
  deduped: 0,
  skipped: 0,
  unchanged: 0,
});
state = await storage.get("exact-review-queue");
assert.equal(state.items[item.key].state, "pending");
assert.equal(state.items[item.key].revision, 2);
assert.equal(state.items[item.key].decision.sourceHeadSha, changedHead);
assert.equal(state.items[item.key].parkedRecoveryAttempts, 0);
assert.equal(state.items[item.key].reviewFailureAttempts, 0);

const policyItem = leasedExactReviewQueueItem(1367, "91367");
policyItem.state = "parked";
policyItem.parkedReason = "review_retry_exhausted";
policyItem.parkedRecoveryAttempts = 3;
policyItem.parkedRecoveryAt = undefined;
policyItem.reviewRetryPolicyEpoch = "1";
policyItem.updatedAt = item.updatedAt;
await storage.put("exact-review-queue", {
  deliveries: {},
  items: { [policyItem.key]: policyItem },
});
const policyQueue = new ExactReviewQueue(
  { storage },
  { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0", EXACT_REVIEW_RETRY_POLICY_EPOCH: "2" },
);
const policyChanged = await policyQueue.fetch(
  new Request("https://clawsweeper-exact-review-queue/parked-reviews/recover-fresh", {
    method: "POST",
    body: JSON.stringify({
      items: [
        {
          item_key: policyItem.key,
          revision: 1,
          updated_at_ms: policyItem.updatedAt,
        },
      ],
      idempotency_key: "proof:policy-epoch",
    }),
  }),
);
assert.deepEqual(await policyChanged.json(), {
  ok: true,
  recovered: 1,
  deduped: 0,
  skipped: 0,
  unchanged: 0,
});
state = await storage.get("exact-review-queue");
assert.equal(state.items[policyItem.key].reviewRetryPolicyEpoch, "2");

const result = {
  proof: "review-retry-fencing-v1",
  source_head: process.env.REVIEW_RETRY_FENCING_SOURCE_HEAD || null,
  runtime: {
    node: process.version,
    queue: "production ExactReviewQueue",
    transport: "Request/Response",
    persistence: "SQLite-backed Durable Storage harness",
  },
  observations: {
    unchanged_source_recovered: false,
    unchanged_budget_preserved: true,
    changed_head_recovered: true,
    changed_head_revision: 2,
    policy_epoch_recovered: true,
    policy_epoch: "2",
  },
  limits: [
    "Runs the production queue module with SQLite-backed local Durable Storage, not deployed workerd.",
    "Uses synthetic source identities and does not call GitHub or mutate a live queue.",
  ],
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result)}\n`);
