import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [stage, outputDir] = process.argv.slice(2);
const baseUrl = process.env.PROOF_BASE_URL || "http://127.0.0.1:8787";
const secret = process.env.PROOF_WEBHOOK_SECRET || "phase0-6-disposable-local-secret";
assert.ok(outputDir);
fs.mkdirSync(outputDir, { recursive: true });

function signature(body) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function signedPost(route, value) {
  const body = JSON.stringify(value);
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature": signature(body),
    },
    body,
  });
  const result = await response.json();
  assert.equal(response.ok, true, JSON.stringify({ route, status: response.status, result }));
  return result;
}

async function publicJson(route) {
  const response = await fetch(`${baseUrl}${route}`);
  const result = await response.json();
  assert.equal(response.ok, true, JSON.stringify({ route, status: response.status, result }));
  return result;
}

function writeReceipt(name, value) {
  fs.writeFileSync(path.join(outputDir, name), `${JSON.stringify(value, null, 2)}\n`);
  console.log(JSON.stringify(value));
}

function assertCause(stats) {
  const causes = stats.lanes.publication.flow.last_15_minutes.causes;
  const retry = causes.rows.find(
    (candidate) =>
      candidate.transition === "retried" &&
      candidate.reason_code === "state_contention" &&
      candidate.pool_class === "repository_actions",
  );
  assert.deepEqual(retry, {
    transition: "retried",
    stage: "state_commit",
    completion_kind: "retryable_failure",
    reason_code: "state_contention",
    revision_relation: "same_revision",
    pool_class: "repository_actions",
    recovery_cause: "state_retry",
    backoff_reason: "publication_retry",
    attempt_bucket: "1",
    count: 1,
  });
  const refresh = causes.rows.find(
    (candidate) =>
      candidate.transition === "refreshed" &&
      candidate.reason_code === "artifact_unavailable" &&
      candidate.pool_class === "repository_actions",
  );
  assert.deepEqual(refresh, {
    transition: "refreshed",
    stage: "publication_prepare",
    completion_kind: "refresh_required",
    reason_code: "artifact_unavailable",
    revision_relation: "same_revision",
    pool_class: "repository_actions",
    recovery_cause: "artifact_refresh",
    backoff_reason: "unknown",
    attempt_bucket: "1",
    count: 1,
  });
  assert.deepEqual(causes.reconciliation.retried, {
    flow_count: 1,
    cause_count: 1,
    complete: true,
  });
  assert.deepEqual(causes.reconciliation.refreshed, {
    flow_count: 1,
    cause_count: 1,
    complete: true,
  });
  assert.equal(causes.attribution_complete, true);
  for (const sentinel of ["openclaw/openclaw", "990601", "phase0-6-proof-batch"]) {
    assert.equal(JSON.stringify(causes).includes(sentinel), false, sentinel);
  }
  return { retry, refresh };
}

if (stage === "queue") {
  const targetRepo = "openclaw/openclaw";
  async function enqueuePublication(itemNumber, producerRunId) {
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
      delivery_id: `phase0-6-proof-publication-${itemNumber}`,
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
  }

  await enqueuePublication(990601, "9990601");
  const claim = await signedPost("/internal/exact-review/publication-batches/claim", {
    claim_id: "phase0-6-proof-claim",
    lease_owner: "phase0-6-proof-worker",
    max_items: 1,
  });
  assert.equal(claim.claimed, true, JSON.stringify(claim));
  const member = claim.batch.items[0];
  const completion = await signedPost("/internal/exact-review/publication-batches/complete", {
    batch_id: claim.batch.batch_id,
    lease_owner: "phase0-6-proof-worker",
    items: [
      {
        item_key: member.item_key,
        revision: member.revision,
        claim_generation: member.claim_generation,
        terminal_outcome: "retryable_failure",
        reason_code: "state_contention",
        pool_class: "repository_actions",
        error_fingerprint: "sha256:local-proof-state-contention",
      },
    ],
  });
  assert.equal(completion.accepted, 1, JSON.stringify(completion));

  await enqueuePublication(990602, "9990602");
  const refreshClaim = await signedPost("/internal/exact-review/publication-batches/claim", {
    claim_id: "phase0-6-proof-refresh-claim",
    lease_owner: "phase0-6-proof-refresh-worker",
    max_items: 1,
  });
  assert.equal(refreshClaim.claimed, true, JSON.stringify(refreshClaim));
  const refreshMember = refreshClaim.batch.items[0];
  const refreshCompletion = await signedPost(
    "/internal/exact-review/publication-batches/complete",
    {
      batch_id: refreshClaim.batch.batch_id,
      lease_owner: "phase0-6-proof-refresh-worker",
      items: [
        {
          item_key: refreshMember.item_key,
          revision: refreshMember.revision,
          claim_generation: refreshMember.claim_generation,
          terminal_outcome: "refresh_required",
          reason_code: "artifact_unavailable",
          pool_class: "repository_actions",
        },
      ],
    },
  );
  assert.equal(refreshCompletion.accepted, 1, JSON.stringify(refreshCompletion));

  const stats = await publicJson("/api/exact-review-queue");
  const causes = assertCause(stats);
  writeReceipt("queue-stage.json", {
    ok: true,
    durable_retry_count: stats.lanes.publication.flow.last_15_minutes.retried,
    durable_refresh_count: stats.lanes.publication.flow.last_15_minutes.refreshed,
    causes,
    privacy_clean: true,
  });
} else if (stage === "cap") {
  const now = Date.now();
  const bucketStart = Math.floor(now / 300_000) * 300_000;
  const telemetry = {
    version: 2,
    receipt_id: "6".repeat(64),
    metrics: [
      {
        bucket_start: new Date(bucketStart).toISOString(),
        deployment_revision: "a".repeat(16),
        config_revision: "b".repeat(16),
        pool_class: "repository_actions",
        pool_identity: "c".repeat(24),
        stage: "publication_apply",
        source_action: "scheduled_hot",
        operation: "comments",
        method: "GET",
        route_template: "issue_comments",
        page_bucket: "1",
        unit: "wire_attempt",
        outcome: "success",
        status_bucket: "2xx",
        latency_bucket: "100_249ms",
        claim_generation_bucket: "1",
        first_repeat: "first",
        attempted: true,
        telemetry_complete: true,
        count: 1,
      },
    ],
    rate_limit_observations: [
      {
        observed_at: new Date(now).toISOString(),
        deployment_revision: "a".repeat(16),
        config_revision: "b".repeat(16),
        pool_class: "target_app",
        pool_identity: "d".repeat(24),
        stage: "publication_apply",
        source_action: "scheduled_hot",
        operation: "item_metadata",
        method: "GET",
        route_template: "issue_metadata",
        page_bucket: "1",
        status: 403,
        headers: {
          retryAfterPresent: false,
          retryAfterSeconds: null,
          limitPresent: true,
          limit: 5000,
          remainingPresent: true,
          remaining: 10,
          usedPresent: true,
          used: 4990,
          resetPresent: true,
          resetEpochSeconds: Math.floor((now + 60_000) / 1000),
          resourcePresent: true,
          resource: "core",
        },
        reset_authority_candidate: "rate_limit_reset",
        telemetry_complete: true,
      },
    ],
  };
  assert.deepEqual(await signedPost("/internal/exact-review/github-egress-telemetry", telemetry), {
    ok: true,
    accepted: true,
    deduped: false,
  });
  const fifteenMinutes = await publicJson("/api/github-egress-observability?hours=0.25");
  const oneHour = await publicJson("/api/github-egress-observability?hours=1");
  const sixHours = await publicJson("/api/github-egress-observability?hours=6");
  for (const view of [fifteenMinutes, oneHour]) {
    assert.equal(view.completeness.rollup_window_complete, true);
    assert.equal(view.completeness.rate_limit_window_complete, true);
    assert.equal(view.completeness.query_complete, true);
    assert.equal(view.units.wire_attempt, 1);
  }
  assert.equal(oneHour.retention.rollup_evicted_rows_total, 2);
  assert.equal(oneHour.retention.rollup_eviction_count_exact, true);
  assert.equal(oneHour.retention.rate_limit_evicted_rows_total, 1);
  assert.ok(Date.parse(oneHour.retention.last_rollup_evicted_bucket_start) < now - 60 * 60_000);
  assert.ok(Date.parse(oneHour.retention.last_rate_limit_evicted_observed_at) < now - 60 * 60_000);
  assert.equal(sixHours.completeness.rollup_window_complete, false);
  assert.equal(sixHours.completeness.rate_limit_window_complete, false);
  assert.equal(sixHours.completeness.query_complete, false);
  assert.deepEqual(oneHour.privacy, {
    pool_identity: "withheld",
    raw_identifiers: false,
    closed_dimensions: true,
  });
  assert.equal(JSON.stringify(oneHour).includes("c".repeat(24)), false);
  assert.equal(JSON.stringify(oneHour).includes("d".repeat(24)), false);
  const stats = await publicJson("/api/exact-review-queue");
  const causes = assertCause(stats);
  writeReceipt("cap-stage.json", {
    ok: true,
    short_windows_complete: true,
    overlapping_window_complete: false,
    rollup_evicted_rows: oneHour.retention.rollup_evicted_rows_total,
    rate_limit_evicted_rows: oneHour.retention.rate_limit_evicted_rows_total,
    causes,
    privacy_clean: true,
  });
} else if (stage === "verify") {
  const oneHour = await publicJson("/api/github-egress-observability?hours=1");
  assert.equal(oneHour.completeness.query_complete, true);
  assert.equal(oneHour.retention.rollup_evicted_rows_total, 2);
  assert.equal(oneHour.retention.rollup_eviction_count_exact, true);
  assert.equal(oneHour.retention.rate_limit_evicted_rows_total, 1);
  const stats = await publicJson("/api/exact-review-queue");
  const causes = assertCause(stats);
  writeReceipt("restart-stage.json", {
    ok: true,
    sqlite_restart_preserved_eviction_watermarks: true,
    sqlite_restart_preserved_cause: true,
    causes,
  });
} else {
  throw new Error(`unknown proof stage: ${stage}`);
}
