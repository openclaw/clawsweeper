import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeStateWriterOperation,
  normalizeStateWriterProgress,
  payloadHash,
} from "../src/state-writer-telemetry.ts";

function operation(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    operation_id: "single:123:1",
    mode: "single_item",
    started_at: "2026-07-21T01:00:00.000Z",
    finished_at: "2026-07-21T01:00:30.000Z",
    wait_ms: 10,
    acquire_attempts: 1,
    acquired: true,
    hold_ms: 20,
    renewals: 0,
    released: true,
    git_duration_ms: 30,
    git_processes: 4,
    commit_count: 1,
    materialized_items: 1,
    configured_batch_size: 1,
    actual_batch_size: 1,
    batch_wait_ms: null,
    outcome: "materialized",
    ...overrides,
  };
}

test("state writer telemetry normalizes valid terminal operations canonically", () => {
  const normalized = normalizeStateWriterOperation(operation());
  assert.ok(normalized);
  assert.equal(payloadHash(normalized), payloadHash(normalized));
  assert.deepEqual(normalizeStateWriterOperation({ ...operation(), schema_version: 2 }), null);
});

test("state writer telemetry enforces lease and batch invariants", () => {
  assert.equal(
    normalizeStateWriterOperation(
      operation({ acquired: false, hold_ms: 1, commit_count: 0, materialized_items: 0 }),
    ),
    null,
  );
  assert.equal(
    normalizeStateWriterOperation(
      operation({
        mode: "batch",
        configured_batch_size: 2,
        actual_batch_size: 2,
        batch_wait_ms: null,
      }),
    ),
    null,
  );
  assert.equal(
    normalizeStateWriterOperation(operation({ outcome: "contention_timeout", acquired: true })),
    null,
  );
  assert.equal(
    normalizeStateWriterOperation(
      operation({ outcome: "materialized", commit_count: 0, materialized_items: 0 }),
    ),
    null,
  );
  assert.equal(
    normalizeStateWriterOperation(
      operation({
        outcome: "unchanged",
        commit_count: 0,
        materialized_items: 0,
        hold_ms: 20,
        released: true,
      }),
    )?.outcome,
    "unchanged",
  );
});

test("state writer progress accepts only monotonic-shaped valid payloads", () => {
  assert.deepEqual(
    normalizeStateWriterProgress({
      schema_version: 1,
      operation_id: "single:123:1",
      mode: "single_item",
      phase: "waiting",
      sequence: 1,
      observed_at: "2026-07-21T01:00:00.000Z",
      configured_batch_size: 1,
      actual_batch_size: 1,
    })?.phase,
    "waiting",
  );
  assert.equal(
    normalizeStateWriterProgress({
      schema_version: 1,
      operation_id: "single:123:1",
      mode: "single_item",
      phase: "waiting",
      sequence: 0,
      observed_at: "2026-07-21T01:00:00.000Z",
      configured_batch_size: 1,
      actual_batch_size: 1,
    }),
    null,
  );
});
