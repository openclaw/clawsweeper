import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

const baseUrl = process.env.PROOF_BASE_URL || "http://127.0.0.1:8787";
const secret = process.env.PROOF_WEBHOOK_SECRET || "phase0-5-proof-secret";

function signature(body) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function signedPost(path, value) {
  const body = JSON.stringify(value);
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature": signature(body),
    },
    body,
  });
  const result = await response.json();
  assert.equal(response.ok, true, JSON.stringify({ path, status: response.status, result }));
  return result;
}

function rateLimitObservation({ poolClass, observedAt, retryAfterSeconds, resetAt, remaining }) {
  const hasRetryAfter = retryAfterSeconds !== undefined;
  return {
    observed_at: new Date(observedAt).toISOString(),
    deployment_revision: "a".repeat(16),
    config_revision: "b".repeat(16),
    pool_class: poolClass,
    pool_identity: "c".repeat(24),
    stage: "publication_apply",
    source_action: "scheduled_hot",
    operation: "item_metadata",
    method: "GET",
    route_template: "issue_metadata",
    page_bucket: "1",
    status: 403,
    headers: {
      retryAfterPresent: hasRetryAfter,
      retryAfterSeconds: hasRetryAfter ? retryAfterSeconds : null,
      limitPresent: true,
      limit: 5_000,
      remainingPresent: true,
      remaining,
      usedPresent: true,
      used: 5_000 - remaining,
      resetPresent: !hasRetryAfter,
      resetEpochSeconds: hasRetryAfter ? null : Math.floor(resetAt / 1_000),
      resourcePresent: true,
      resource: "core",
    },
    reset_authority_candidate: hasRetryAfter ? "retry_after" : "rate_limit_reset",
    telemetry_complete: true,
  };
}

async function waitUntil(timestamp) {
  const delay = timestamp - Date.now();
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

const producerRunId = "9990001";
const itemNumber = 990001;
const targetRepo = "openclaw/openclaw";
const producerDecision = {
  targetRepo,
  targetBranch: "main",
  itemNumber,
  itemKind: "issue",
  sourceEvent: "issues",
  sourceAction: "opened",
  supersedesInProgress: false,
};
const enqueue = await signedPost("/internal/exact-review/enqueue", {
  delivery_id: "phase0-5-proof-publication",
  decision: {
    ...producerDecision,
    sourceAction: "exact_review_artifact_publish",
    publication: {
      artifactName: `exact-review-${producerRunId}-1`,
      producerRunId,
      producerRunAttempt: 1,
      sourceSha: "d".repeat(40),
      itemKey: `${targetRepo}#${itemNumber}`,
      protocolVersion: 2,
      leaseRevision: 1,
      claimGeneration: 1,
      liveProceeded: true,
      liveTerminalNoop: false,
      liveTerminalMissing: false,
      liveGuardedOpen: false,
      producerDecision,
    },
  },
});
assert.equal(enqueue.queued, true, JSON.stringify(enqueue));

const observedAt = Date.now();
const retryAfterSeconds = 2;
const telemetry = {
  version: 2,
  receipt_id: "1".repeat(64),
  metrics: [],
  rate_limit_observations: [
    rateLimitObservation({
      poolClass: "public_read_fallback",
      observedAt,
      retryAfterSeconds,
      remaining: 0,
    }),
    rateLimitObservation({
      poolClass: "target_app",
      observedAt: observedAt + 1,
      resetAt: observedAt + 60_000,
      remaining: 0,
    }),
    rateLimitObservation({
      poolClass: "repository_actions",
      observedAt: observedAt + 2,
      resetAt: observedAt + 90_000,
      remaining: 10,
    }),
  ],
};
assert.deepEqual(await signedPost("/internal/exact-review/github-egress-telemetry", telemetry), {
  ok: true,
  accepted: true,
  deduped: false,
});
assert.deepEqual(await signedPost("/internal/exact-review/github-egress-telemetry", telemetry), {
  ok: true,
  accepted: false,
  deduped: true,
});

const conflictReceipt = {
  version: 2,
  receipt_id: "2".repeat(64),
  metrics: [],
  rate_limit_observations: [
    rateLimitObservation({
      poolClass: "target_app",
      observedAt: observedAt + 3,
      resetAt: observedAt + 60_000,
      remaining: 0,
    }),
  ],
};
assert.deepEqual(
  await signedPost("/internal/exact-review/github-egress-telemetry", conflictReceipt),
  { ok: true, accepted: true, deduped: false },
);
assert.deepEqual(
  await signedPost("/internal/exact-review/github-egress-telemetry", {
    ...conflictReceipt,
    rate_limit_observations: [
      rateLimitObservation({
        poolClass: "public_read_fallback",
        observedAt: observedAt + 4,
        retryAfterSeconds: 4,
        remaining: 0,
      }),
    ],
  }),
  { ok: true, accepted: false, deduped: true },
);

const statsResponse = await fetch(`${baseUrl}/api/exact-review-queue`);
assert.equal(statsResponse.ok, true, `stats HTTP ${statsResponse.status}`);
const stats = await statsResponse.json();
const circuits = stats.lanes.publication.credential_circuits;
assert.equal(circuits.length, 1, JSON.stringify(circuits));
assert.equal(circuits[0].pool, "actions:openclaw/clawsweeper");
assert.equal(circuits[0].scope, "repository_actions");
assert.equal(circuits[0].target_owner, null);
assert.equal(circuits[0].reset_source, "retry_after");
assert.equal(circuits[0].authoritative, true);
assert.equal(circuits[0].affected_pending, 1);
const blockedUntil = Date.parse(circuits[0].blocked_until);
const recoveryUntil = Date.parse(circuits[0].recovery_until);
assert.equal(blockedUntil, observedAt + retryAfterSeconds * 1_000);
assert.ok(recoveryUntil > blockedUntil);
assert.ok(recoveryUntil <= blockedUntil + 30_000);
assert.deepEqual(stats.handoff_health.recovery_reasons, {
  claim_timeout: 0,
  execution_timeout: 0,
  workflow_cancelled: 0,
  workflow_failed: 0,
});
assert.equal(JSON.stringify(stats).includes("pool_identity"), false);

const claim = (claimId) =>
  signedPost("/internal/exact-review/publication-batches/claim", {
    claim_id: claimId,
    lease_owner: claimId,
    max_items: 1,
  });
assert.equal((await claim("proof-before-reset")).claimed, false);
await waitUntil(blockedUntil + 100);
assert.equal((await claim("proof-at-reset")).claimed, false);
await waitUntil(recoveryUntil + 100);
const recovered = await claim("proof-after-jitter");
assert.equal(recovered.claimed, true, JSON.stringify(recovered));
assert.equal(recovered.batch.items.length, 1);

console.log(
  JSON.stringify({
    ok: true,
    signed_ingest_deduped: true,
    conflicting_receipt_fenced: true,
    attributable_circuit_count: circuits.length,
    blocked_until: circuits[0].blocked_until,
    recovery_until: circuits[0].recovery_until,
    raw_reset_claimed: false,
    jitter_recovery_claimed: true,
    privacy_clean: true,
  }),
);
