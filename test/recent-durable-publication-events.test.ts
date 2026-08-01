import assert from "node:assert/strict";
import test from "node:test";

import {
  RECENT_DURABLE_PUBLICATION_EVENT_SCAN_LIMIT,
  recentDurablePublicationEvents,
} from "../dashboard/recent-durable-publication-events.ts";

const now = Date.parse("2026-08-01T12:00:00.000Z");

function storage(rows: Record<string, unknown>[]) {
  return {
    sql: {
      exec: (query: string) => (query.includes("telemetry_batch_v1") ? [] : rows),
    },
  };
}

function splitStorage(direct: Record<string, unknown>[], batch: Record<string, unknown>[]) {
  return {
    sql: {
      exec: (query: string) => (query.includes("telemetry_batch_v1") ? batch : direct),
    },
  };
}

test("recent durable publication events bucket each requested window without lifecycle inference", () => {
  for (const [window, age] of [
    ["6h", 30 * 60_000],
    ["24h", 3 * 60 * 60_000],
    ["7d", 3 * 24 * 60 * 60_000],
  ] as const) {
    const view = recentDurablePublicationEvents({
      storage: storage([{ outcome: "accepted", observed_at: now - age }]),
      window,
      now,
    });
    assert.equal(view?.collection.complete, true);
    assert.equal(view?.window.id, window);
    assert.equal(view?.direct.counts.accepted, 1);
    assert.equal(view?.direct.buckets.length, 24);
    assert.equal(JSON.stringify(view).includes("workflow"), false);
  }
});

test("recent durable publication events preserve idle and unknown without partial counts", () => {
  const idle = recentDurablePublicationEvents({ storage: storage([]), window: "24h", now });
  assert.equal(idle?.activity.state, "idle");
  const capped = recentDurablePublicationEvents({
    storage: storage(
      Array.from({ length: RECENT_DURABLE_PUBLICATION_EVENT_SCAN_LIMIT + 1 }, () => ({
        outcome: "accepted",
        observed_at: now - 1,
      })),
    ),
    window: "24h",
    now,
  });
  assert.equal(capped?.collection.complete, false);
  assert.equal(capped?.direct.counts.accepted, null);
  assert.equal(capped?.batch.counts.retryable, 0);
});

test("recent durable publication events keep malformed and mixed sources unknown and redact rows", () => {
  const mixed = recentDurablePublicationEvents({
    storage: splitStorage([{ outcome: "invalid", observed_at: null }], []),
    window: "6h",
    now,
  });
  assert.equal(mixed?.collection.complete, false);
  assert.equal(mixed?.collection.state, "mixed");
  assert.equal(mixed?.direct.counts.accepted, null);
  assert.equal(mixed?.batch.counts.retryable, 0);
  assert.deepEqual(mixed?.provenance.omitted, [
    "canonical_target_key",
    "fence_key",
    "revision",
    "claim_generation",
    "event_id",
  ]);
  assert.doesNotMatch(JSON.stringify(mixed), /"canonical_target_key"\s*:/);
});
