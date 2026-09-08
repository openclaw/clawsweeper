import assert from "node:assert/strict";
import test from "node:test";

import { summarizeDashboardHealth } from "../dashboard/dashboard-health.ts";

function healthySnapshot(): Record<string, unknown> {
  return {
    diagnostics: { exact_review_queue_error: null },
    exact_review_queue: {
      handoff_health: { status: "healthy" },
      review_failure_health: { status: "healthy" },
      lanes: {
        publication: {
          health: { status: "healthy" },
          dead_letters: { open: 0 },
        },
      },
    },
    operational_health: { status: "healthy" },
    health: { unresolved_failures: 0 },
    recent: {
      apply_health: { items: [] },
      automerge_reliability: { unresolved_failures: 0, stalled_attempts: 0 },
    },
  };
}

test("dashboard health is green only when every top-level signal is healthy", () => {
  assert.deepEqual(summarizeDashboardHealth(healthySnapshot()), {
    conclusion: "all_clear",
    severity: "green",
    reasons: [],
  });
  const idle = healthySnapshot();
  idle.operational_health = { status: "idle" };
  assert.equal(summarizeDashboardHealth(idle).severity, "green");
});

test("dashboard health rolls publication, DLQ, and missing queue telemetry upward", () => {
  const degraded = healthySnapshot();
  const queue = degraded.exact_review_queue as Record<string, any>;
  queue.lanes.publication.health.status = "degraded";
  queue.lanes.publication.dead_letters.open = 2;
  assert.deepEqual(summarizeDashboardHealth(degraded), {
    conclusion: "needs_attention",
    severity: "amber",
    reasons: ["publication_degraded", "publication_dlq_open"],
  });

  const unavailable = healthySnapshot();
  unavailable.exact_review_queue = null;
  assert.deepEqual(summarizeDashboardHealth(unavailable), {
    conclusion: "needs_attention",
    severity: "amber",
    reasons: ["queue_telemetry_unavailable"],
  });
});

test("dashboard health maps critical and stalled signals to red", () => {
  const snapshot = healthySnapshot();
  const queue = snapshot.exact_review_queue as Record<string, any>;
  queue.lanes.publication.health.status = "critical";
  assert.deepEqual(summarizeDashboardHealth(snapshot), {
    conclusion: "needs_attention",
    severity: "red",
    reasons: ["publication_critical"],
  });
});

test("dashboard health raises recent and exhausted review failures", () => {
  const recent = healthySnapshot();
  const recentQueue = recent.exact_review_queue as Record<string, any>;
  recentQueue.review_failure_health = { status: "degraded" };
  assert.deepEqual(summarizeDashboardHealth(recent), {
    conclusion: "needs_attention",
    severity: "amber",
    reasons: ["review_failures_recent"],
  });

  const repeated = healthySnapshot();
  const repeatedQueue = repeated.exact_review_queue as Record<string, any>;
  repeatedQueue.review_failure_health = { status: "critical" };
  repeatedQueue.lanes.review = {
    parked_reasons: { review_retry_exhausted: 2 },
  };
  assert.deepEqual(summarizeDashboardHealth(repeated), {
    conclusion: "needs_attention",
    severity: "red",
    reasons: ["review_failures_repeated", "review_retries_exhausted"],
  });
});

test("dashboard health fails amber when a required signal is absent", () => {
  const snapshot = healthySnapshot();
  const queue = snapshot.exact_review_queue as Record<string, any>;
  delete queue.lanes.publication.health;
  delete snapshot.operational_health;
  assert.deepEqual(summarizeDashboardHealth(snapshot), {
    conclusion: "needs_attention",
    severity: "amber",
    reasons: ["publication_health_unavailable", "workflow_execution_degraded"],
  });
});

test("dashboard health reports absent review failure telemetry", () => {
  const snapshot = healthySnapshot();
  const queue = snapshot.exact_review_queue as Record<string, any>;
  delete queue.review_failure_health;
  assert.deepEqual(summarizeDashboardHealth(snapshot), {
    conclusion: "needs_attention",
    severity: "amber",
    reasons: ["review_failure_telemetry_unavailable"],
  });
});

test("dashboard health raises a failed terminal explanation distinctly", () => {
  const snapshot = healthySnapshot();
  const queue = snapshot.exact_review_queue as Record<string, any>;
  queue.review_failure_health = {
    status: "critical",
    reasons: ["terminal_status_delivery_failed", "terminal_review_failure"],
  };
  assert.deepEqual(summarizeDashboardHealth(snapshot), {
    conclusion: "needs_attention",
    severity: "red",
    reasons: ["review_status_delivery_failed"],
  });
});
