import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeReviewTelemetry,
  summarizeReviewTelemetryHealth,
} from "../dashboard/review-telemetry.ts";

const NOW = Date.parse("2026-07-19T12:00:00.000Z");

function telemetry(overrides: Record<string, unknown> = {}) {
  return {
    repo: "openclaw/openclaw",
    item_number: 123,
    run_id: "9001",
    run_attempt: 2,
    status: "refreshing",
    outcome: null,
    started_at: "2026-07-19T10:00:00.000Z",
    updated_at: "2026-07-19T11:50:00.000Z",
    lease_expires_at: "2026-07-19T12:10:00.000Z",
    phase_durations_ms: { queue: 1000, claim: 2000 },
    ...overrides,
  };
}

test("review telemetry contract accepts optional generation and operation identity", () => {
  assert.deepEqual(
    normalizeReviewTelemetry(telemetry({ generation: 4, operation_id: "review:123:4" }), NOW),
    telemetry({ generation: 4, operation_id: "review:123:4" }),
  );
  assert.equal(normalizeReviewTelemetry(telemetry({ outcome: "succeeded" }), NOW), null);
  assert.equal(
    normalizeReviewTelemetry(
      telemetry({ status: "completed", outcome: "succeeded", phase_durations_ms: { total: -1 } }),
      NOW,
    ),
    null,
  );
});

test("review telemetry rejects identifiers outside SQLite's reliable integer range", () => {
  assert.equal(normalizeReviewTelemetry(telemetry({ item_number: 1e20 }), NOW), null);
  assert.equal(normalizeReviewTelemetry(telemetry({ run_attempt: 1e20 }), NOW), null);
});

test("review telemetry watchdog uses green, amber, and red thresholds", () => {
  const fresh = normalizeReviewTelemetry(telemetry(), NOW)!;
  assert.equal(summarizeReviewTelemetryHealth([fresh], NOW).status, "healthy");

  const slow = normalizeReviewTelemetry(
    telemetry({ updated_at: "2026-07-19T11:29:59.000Z", lease_expires_at: null }),
    NOW,
  )!;
  assert.equal(summarizeReviewTelemetryHealth([slow], NOW).status, "degraded");

  const orphan = normalizeReviewTelemetry(
    telemetry({
      started_at: "2026-07-19T08:00:00.000Z",
      updated_at: "2026-07-19T09:29:59.000Z",
      lease_expires_at: null,
    }),
    NOW,
  )!;
  const critical = summarizeReviewTelemetryHealth([orphan], NOW);
  assert.equal(critical.status, "critical");
  assert.equal(critical.orphan_refreshing, 1);
  assert.deepEqual(critical.orphans[0], {
    repo: "openclaw/openclaw",
    item_number: 123,
    run_id: "9001",
    run_attempt: 2,
    updated_at: "2026-07-19T09:29:59.000Z",
    age_seconds: 9001,
    lease_expires_at: null,
  });
});

test("an explicitly active lease prevents orphan classification", () => {
  const active = normalizeReviewTelemetry(
    telemetry({
      started_at: "2026-07-19T08:00:00.000Z",
      updated_at: "2026-07-19T09:00:00.000Z",
      lease_expires_at: "2026-07-19T12:01:00.000Z",
    }),
    NOW,
  )!;
  const health = summarizeReviewTelemetryHealth([active], NOW);
  assert.equal(health.status, "degraded");
  assert.equal(health.orphan_refreshing, 0);
});

test("review telemetry rejects producer clocks that could pin an attempt in the future", () => {
  assert.equal(
    normalizeReviewTelemetry(
      telemetry({ updated_at: "2026-07-19T12:05:01.000Z", lease_expires_at: null }),
      NOW,
    ),
    null,
  );
  assert.equal(
    normalizeReviewTelemetry(telemetry({ lease_expires_at: "2026-07-20T12:00:01.000Z" }), NOW),
    null,
  );
});

test("review telemetry reports every orphan while bounding the locator list", () => {
  const records = Array.from({ length: 25 }, (_, index) =>
    normalizeReviewTelemetry(
      telemetry({
        item_number: index + 1,
        run_id: String(index + 1),
        started_at: "2026-07-19T08:00:00.000Z",
        updated_at: "2026-07-19T09:00:00.000Z",
        lease_expires_at: null,
      }),
      NOW,
    ),
  ).filter((record) => record !== null);
  const health = summarizeReviewTelemetryHealth(records, NOW);
  assert.equal(health.orphan_refreshing, 25);
  assert.equal(health.orphans.length, 20);
});
