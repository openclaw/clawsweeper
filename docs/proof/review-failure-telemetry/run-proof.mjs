import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { summarizeDashboardHealth } from "../../../dashboard/dashboard-health.ts";
import {
  ExactReviewQueue,
  MemoryDurableNamespace,
  MemoryDurableStorage,
  leasedExactReviewQueueItem,
  worker,
} from "../../../test/dashboard-worker-harness.ts";

const outputPath = process.env.REVIEW_FAILURE_TELEMETRY_PROOF_OUTPUT;
if (!outputPath) throw new Error("REVIEW_FAILURE_TELEMETRY_PROOF_OUTPUT is required");

const storage = new MemoryDurableStorage();
const item = leasedExactReviewQueueItem(135798, "9001");
const source = {
  sourceHeadSha: "1".repeat(40),
  sourceContentRevision: "2".repeat(64),
  sourceUpdatedAt: "2026-09-02T19:50:00.000Z",
};
item.decision = { ...item.decision, ...source };
item.leaseDecision = { ...item.leaseDecision, ...source };
await storage.put("exact-review-queue", {
  deliveries: {},
  items: { [item.key]: item },
});
const queue = new ExactReviewQueue({ storage }, {});

const completion = (runId, claimGeneration) => ({
  lease_id: item.leaseId,
  item_key: item.key,
  lease_revision: 1,
  claim_generation: claimGeneration,
  run_id: runId,
  run_attempt: 1,
  outcome: "failure",
  review_failure: {
    stage: "agent_input_scan",
    reason_code: "scanner_failed",
    retryable: false,
  },
});
const complete = (body) =>
  queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );

const first = await complete(completion("9001", 1));
assert.equal(first.status, 200);
assert.deepEqual(await first.json(), { ok: true, requeued: true });

const state = await storage.get("exact-review-queue");
const secondItem = state.items[item.key];
Object.assign(secondItem, {
  state: "leased",
  leaseId: item.leaseId,
  leaseRevision: 1,
  leaseDecision: { ...secondItem.decision },
  leaseExpiresAt: Date.now() + 60 * 60_000,
  claimedRunId: "9002",
  claimedRunAttempt: 1,
  claimGeneration: 2,
  claimProtocolVersion: 2,
});
await storage.put("exact-review-queue", state);

const secondBody = completion("9002", 2);
const second = await complete(secondBody);
assert.equal(second.status, 200);
assert.deepEqual(await second.json(), { ok: true, requeued: true });
const replay = await complete(secondBody);
assert.equal(replay.status, 409);

const publicResponse = await worker.fetch(
  new Request("https://clawsweeper.openclaw.ai/api/exact-review-queue"),
  {
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    PUBLIC_BAY_REPOS: "openclaw/openclaw",
  },
);
assert.equal(publicResponse.status, 200);
const publicQueue = await publicResponse.json();
assert.deepEqual(publicQueue.review_failure_health, {
  status: "critical",
  reasons: ["repeated_failure_identity", "terminal_review_failure"],
  window_minutes: 60,
  attempts: 2,
  affected_targets: 1,
  retryable_attempts: 0,
  terminal_attempts: 2,
  repeated_identities: 1,
  first_seen_at: publicQueue.review_failure_health.first_seen_at,
  last_seen_at: publicQueue.review_failure_health.last_seen_at,
  by_stage: {
    agent_input_scan: 2,
    source_preparation: 0,
    provider_or_model: 0,
    workflow: 0,
  },
});

const operatorBody = JSON.stringify({ limit: 10 });
const operatorSecret = "disposable-local-proof-secret";
const operatorResponse = await worker.fetch(
  new Request("https://clawsweeper.openclaw.ai/internal/exact-review/review-failures/list", {
    method: "POST",
    headers: {
      "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", operatorSecret)
        .update(operatorBody)
        .digest("hex")}`,
    },
    body: operatorBody,
  }),
  {
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    EXACT_REVIEW_OPERATOR_SECRET: operatorSecret,
  },
);
assert.equal(operatorResponse.status, 200);
const operatorInventory = await operatorResponse.json();
assert.equal(operatorInventory.attempts.length, 2);
assert.ok(
  operatorInventory.attempts.every(
    (attempt) =>
      attempt.target === "openclaw/openclaw#135798" &&
      attempt.stage === "agent_input_scan" &&
      attempt.reason_code === "scanner_failed" &&
      attempt.retryable === false,
  ),
);

const health = summarizeDashboardHealth({
  diagnostics: {},
  exact_review_queue: {
    ...publicQueue,
    lanes: {
      ...publicQueue.lanes,
      publication: { ...publicQueue.lanes.publication, health: { status: "healthy" } },
    },
  },
  operational_health: { status: "healthy" },
  health: { unresolved_failures: 0 },
  recent: {
    apply_health: { items: [] },
    automerge_reliability: { unresolved_failures: 0, stalled_attempts: 0 },
  },
});
assert.deepEqual(health, {
  conclusion: "needs_attention",
  severity: "red",
  reasons: ["review_failures_repeated"],
});

const serializedPublic = JSON.stringify(publicQueue);
assert.doesNotMatch(serializedPublic, /9001|9002|source_fingerprint|failure_fingerprint/);
const result = {
  proof: "review-failure-telemetry-v1",
  runtime: {
    node: process.version,
    queue: "production ExactReviewQueue",
    transport: "Request/Response",
    persistence: "SQLite-backed Durable Storage harness",
  },
  observations: {
    first_completion_requeued: true,
    duplicate_completion_rejected: true,
    durable_attempts: operatorInventory.attempts.length,
    affected_targets: publicQueue.review_failure_health.affected_targets,
    repeated_identities: publicQueue.review_failure_health.repeated_identities,
    public_status: publicQueue.review_failure_health.status,
    dashboard_severity: health.severity,
    private_failure_identifiers_redacted: true,
  },
  limits: [
    "Runs the production queue and Worker modules with SQLite-backed local Durable Storage, not deployed workerd.",
    "Uses synthetic source identities and does not call GitHub or mutate a live queue.",
  ],
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result)}\n`);
