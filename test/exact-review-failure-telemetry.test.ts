import assert from "node:assert/strict";
import test from "node:test";

import {
  EXACT_REVIEW_FAILURE_HEALTH_WINDOW_MS,
  EXACT_REVIEW_FAILURE_TELEMETRY_RETENTION_MS,
  ExactReviewFailureTelemetryStore,
  exactReviewFailureSourceFingerprint,
  normalizeExactReviewFailureDetail,
  normalizeExactReviewFailureStatus,
  stableExactReviewFailureFingerprint,
} from "../dashboard/exact-review-failure-telemetry.ts";
import { MemoryDurableStorage } from "./dashboard-worker-harness.ts";

const NOW = Date.parse("2026-09-02T20:00:00.000Z");

test("review failure telemetry validates only closed sanitized classifications", () => {
  assert.deepEqual(
    normalizeExactReviewFailureDetail({
      stage: "agent_input_scan",
      reason_code: "findings",
      retryable: false,
    }),
    { stage: "agent_input_scan", reasonCode: "findings", retryable: false },
  );
  for (const value of [
    { stage: "arbitrary", reason_code: "findings", retryable: false },
    { stage: "agent_input_scan", reason_code: "private detail", retryable: false },
    { stage: "agent_input_scan", reason_code: "findings", retryable: "false" },
  ]) {
    assert.equal(normalizeExactReviewFailureDetail(value), null);
  }
});

test("review failure telemetry validates terminal status receipts", () => {
  assert.deepEqual(
    normalizeExactReviewFailureStatus({
      outcome: "observed",
      comment_id: 4200,
      completed_at: "2026-09-02T20:00:00.000Z",
    }),
    {
      outcome: "observed",
      commentId: 4200,
      completedAt: "2026-09-02T20:00:00.000Z",
    },
  );
  assert.deepEqual(normalizeExactReviewFailureStatus({ outcome: "unavailable" }), {
    outcome: "unavailable",
    commentId: null,
    completedAt: null,
  });
  assert.equal(normalizeExactReviewFailureStatus({ outcome: "observed" }), null);
  assert.equal(
    normalizeExactReviewFailureStatus({ outcome: "failed", comment_id: "raw detail" }),
    null,
  );
  assert.equal(
    normalizeExactReviewFailureStatus({
      outcome: "failed",
      comment_id: 4200,
      completed_at: "2026-09-02T20:00:00.000Z",
    }),
    null,
  );
});

test("terminal status receipts accept explicit null nullable fields", () => {
  assert.deepEqual(
    normalizeExactReviewFailureStatus({
      outcome: "failed",
      comment_id: 42,
      completed_at: null,
    }),
    { outcome: "failed", commentId: 42, completedAt: null },
  );
  assert.deepEqual(
    normalizeExactReviewFailureStatus({
      outcome: "unavailable",
      comment_id: null,
      completed_at: null,
    }),
    { outcome: "unavailable", commentId: null, completedAt: null },
  );
});

test("terminal status delivery failures alert without changing attempt identity", () => {
  const store = new ExactReviewFailureTelemetryStore(new MemoryDurableStorage());
  store.recordSync({
    attemptId: "e".repeat(64),
    canonicalTargetKey: "openclaw/openclaw#42",
    fenceKey: "openclaw/openclaw#42",
    revision: 1,
    claimGeneration: 1,
    runId: "2001",
    runAttempt: 1,
    sourceFingerprint: "1".repeat(64),
    failureFingerprint: "2".repeat(64),
    sourceHeadSha: "3".repeat(40),
    sourceContentRevision: "4".repeat(64),
    sourceUpdatedAt: null,
    stage: "agent_input_scan",
    reasonCode: "findings",
    retryable: false,
    observedAt: NOW,
    status: { outcome: "failed", commentId: 4200, completedAt: null },
  });
  const summary = store.summarySync(NOW);
  assert.equal(summary.status, "critical");
  assert.deepEqual(summary.reasons, ["terminal_status_delivery_failed", "terminal_review_failure"]);
  assert.equal(summary.terminal_status_failed, 1);
  assert.equal(summary.terminal_status_observed, 0);
  assert.deepEqual(store.listSync({ limit: 10, now: NOW }).attempts[0]?.terminal_status, {
    outcome: "failed",
    comment_id: 4200,
    completed_at: null,
  });
});

test("unavailable terminal status does not raise a delivery failure incident", () => {
  const store = new ExactReviewFailureTelemetryStore(new MemoryDurableStorage());
  store.recordSync({
    attemptId: "f".repeat(64),
    canonicalTargetKey: "openclaw/openclaw#43",
    fenceKey: "openclaw/openclaw#43",
    revision: 1,
    claimGeneration: 1,
    runId: "2002",
    runAttempt: 1,
    sourceFingerprint: "5".repeat(64),
    failureFingerprint: "6".repeat(64),
    sourceHeadSha: "7".repeat(40),
    sourceContentRevision: "8".repeat(64),
    sourceUpdatedAt: null,
    stage: "agent_input_scan",
    reasonCode: "findings",
    retryable: false,
    observedAt: NOW,
    status: { outcome: "unavailable", commentId: null, completedAt: null },
  });
  const summary = store.summarySync(NOW);
  assert.equal(summary.status, "degraded");
  assert.deepEqual(summary.reasons, ["terminal_review_failure"]);
  assert.equal(summary.terminal_status_failed, 0);
});

test("review failure fingerprints are synchronous, stable, and source-sensitive", () => {
  const first = stableExactReviewFailureFingerprint("source-a");
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(stableExactReviewFailureFingerprint("source-a"), first);
  assert.notEqual(stableExactReviewFailureFingerprint("source-b"), first);
});

test("review failure source fingerprints distinguish PR base revisions", () => {
  const decision = {
    targetRepo: "openclaw/openclaw",
    targetBranch: "main",
    itemNumber: 135798,
    itemKind: "pull_request" as const,
    sourceEvent: "pull_request" as const,
    sourceAction: "synchronize",
    supersedesInProgress: true,
    sourceHeadSha: "a".repeat(40),
    sourceBaseSha: "b".repeat(40),
    sourceUpdatedAt: "2026-09-02T19:50:00.000Z",
  };
  assert.notEqual(
    exactReviewFailureSourceFingerprint(decision),
    exactReviewFailureSourceFingerprint({ ...decision, sourceBaseSha: "c".repeat(40) }),
  );
  assert.notEqual(
    exactReviewFailureSourceFingerprint(decision),
    exactReviewFailureSourceFingerprint({ ...decision, sourceAction: "unlocked" }),
  );
  assert.notEqual(
    exactReviewFailureSourceFingerprint(decision),
    exactReviewFailureSourceFingerprint({ ...decision, targetBranch: "next" }),
  );
  const withContent = { ...decision, sourceContentRevision: "d".repeat(64) };
  assert.equal(
    exactReviewFailureSourceFingerprint(withContent),
    exactReviewFailureSourceFingerprint({
      ...withContent,
      sourceUpdatedAt: "2026-09-02T19:55:00.000Z",
    }),
  );
  assert.notEqual(
    exactReviewFailureSourceFingerprint(decision),
    exactReviewFailureSourceFingerprint({
      ...decision,
      sourceUpdatedAt: "2026-09-02T19:55:00.000Z",
    }),
  );
});

test("review failure telemetry deduplicates attempts and detects repeated source failures", () => {
  const store = new ExactReviewFailureTelemetryStore(new MemoryDurableStorage());
  const base = {
    canonicalTargetKey: "openclaw/openclaw#135798",
    fenceKey: "openclaw/openclaw#135798",
    revision: 7,
    sourceFingerprint: "1".repeat(64),
    failureFingerprint: "2".repeat(64),
    sourceHeadSha: "3".repeat(40),
    sourceContentRevision: "4".repeat(64),
    sourceUpdatedAt: "2026-09-02T19:50:00.000Z",
    stage: "agent_input_scan",
    reasonCode: "findings",
    retryable: false,
  };
  const first = {
    ...base,
    attemptId: "a".repeat(64),
    claimGeneration: 1,
    runId: "1001",
    runAttempt: 1,
    observedAt: NOW - 60_000,
  };
  const second = {
    ...base,
    attemptId: "b".repeat(64),
    claimGeneration: 2,
    runId: "1002",
    runAttempt: 1,
    observedAt: NOW,
  };
  store.recordSync(first);
  store.recordSync(first);
  store.recordSync(second);

  assert.deepEqual(store.summarySync(NOW), {
    status: "critical",
    reasons: ["repeated_failure_identity", "terminal_review_failure"],
    window_minutes: 60,
    attempts: 2,
    affected_targets: 1,
    retryable_attempts: 0,
    terminal_attempts: 2,
    terminal_status_observed: 0,
    terminal_status_failed: 0,
    repeated_identities: 1,
    first_seen_at: "2026-09-02T19:59:00.000Z",
    last_seen_at: "2026-09-02T20:00:00.000Z",
    by_stage: {
      agent_input_scan: 2,
      source_preparation: 0,
      provider_or_model: 0,
      workflow: 0,
    },
  });

  const inventory = store.listSync({ limit: 1 });
  assert.equal(inventory.attempts.length, 1);
  assert.equal(inventory.attempts[0]?.target, "openclaw/openclaw#135798");
  assert.equal(inventory.attempts[0]?.reason_code, "findings");
  assert.equal(inventory.attempts[0]?.retryable, false);
  assert.equal(inventory.next_cursor, `${NOW}:${"b".repeat(64)}`);
  assert.doesNotMatch(JSON.stringify(inventory), /private|secret|scanner output/i);
});

test("review failure telemetry does not join failures across source revisions", () => {
  const store = new ExactReviewFailureTelemetryStore(new MemoryDurableStorage());
  for (const [index, sourceFingerprint] of ["1".repeat(64), "2".repeat(64)].entries()) {
    store.recordSync({
      attemptId: String(index + 3).repeat(64),
      canonicalTargetKey: "openclaw/openclaw#42",
      fenceKey: "openclaw/openclaw#42",
      revision: index + 1,
      claimGeneration: 1,
      runId: String(2000 + index),
      runAttempt: 1,
      sourceFingerprint,
      failureFingerprint: "f".repeat(64),
      sourceHeadSha: null,
      sourceContentRevision: null,
      sourceUpdatedAt: new Date(NOW + index * 60_000).toISOString(),
      stage: "agent_input_scan",
      reasonCode: "findings",
      retryable: false,
      observedAt: NOW + index * 60_000,
    });
  }
  const summary = store.summarySync(NOW + 60_000);
  assert.equal(summary.attempts, 2);
  assert.equal(summary.repeated_identities, 0);
  assert.equal(summary.status, "degraded");
});

test("review failure telemetry repairs schema readiness after an outer rollback", () => {
  const storage = new MemoryDurableStorage();
  const store = new ExactReviewFailureTelemetryStore(storage);

  assert.throws(
    () =>
      storage.transactionSync(() => {
        assert.equal(store.summarySync(NOW).status, "healthy");
        throw new Error("rollback after telemetry schema creation");
      }),
    /rollback after telemetry schema creation/,
  );

  assert.equal(store.summarySync(NOW).status, "healthy");
});

test("review failure telemetry enforces retention without stats polling", () => {
  const store = new ExactReviewFailureTelemetryStore(new MemoryDurableStorage());
  const attempt = {
    attemptId: "a".repeat(64),
    canonicalTargetKey: "openclaw/openclaw#42",
    fenceKey: "openclaw/openclaw#42",
    revision: 1,
    claimGeneration: 1,
    runId: "2001",
    runAttempt: 1,
    sourceFingerprint: "1".repeat(64),
    failureFingerprint: "2".repeat(64),
    sourceHeadSha: null,
    sourceContentRevision: null,
    sourceUpdatedAt: null,
    stage: "workflow",
    reasonCode: "workflow_failed",
    retryable: true,
    observedAt: NOW,
  };
  store.recordSync(attempt);

  assert.equal(
    store.listSync({
      limit: 10,
      now: NOW + EXACT_REVIEW_FAILURE_TELEMETRY_RETENTION_MS + 1,
    }).attempts.length,
    0,
  );
});

test("review failure telemetry persists and expires dropped-attempt health", () => {
  const storage = new MemoryDurableStorage();
  new ExactReviewFailureTelemetryStore(storage).recordDropSync(NOW);

  const restartedStore = new ExactReviewFailureTelemetryStore(storage);
  assert.deepEqual(restartedStore.summarySync(NOW).reasons, ["telemetry_unavailable"]);
  assert.equal(restartedStore.summarySync(NOW).status, "unknown");

  const recovered = restartedStore.summarySync(NOW + EXACT_REVIEW_FAILURE_HEALTH_WINDOW_MS + 1);
  assert.equal(recovered.status, "healthy");
  assert.deepEqual(recovered.reasons, []);
});
