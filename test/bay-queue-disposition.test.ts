import assert from "node:assert/strict";
import test from "node:test";
import {
  exactReviewQueueBayProjectionFromStats,
  exactReviewQueueStats as queueCensus,
} from "../dashboard/exact-review-read-model.ts";
import { publicStatusProjection } from "../dashboard/worker.ts";
import { unclaimedExactReviewQueueItem } from "./dashboard-worker-harness.ts";

test("Bay retains exhausted, recoverable and unscheduled parked dispositions without private detail", () => {
  const exhausted = unclaimedExactReviewQueueItem(990001, "990001");
  exhausted.state = "parked";
  exhausted.parkedReason = "review_retry_exhausted";
  exhausted.parkedRecoveryAttempts = 3;
  const retry = {
    ...exhausted,
    key: "openclaw/gogcli#990002",
    decision: { ...exhausted.decision, itemNumber: 990002 },
    parkedRecoveryAttempts: 1,
  };
  const attention = {
    ...exhausted,
    key: "openclaw/gogcli#990003",
    decision: { ...exhausted.decision, itemNumber: 990003 },
    parkedReason: "dead_letter_capacity" as const,
  };
  const projection = exactReviewQueueBayProjectionFromStats(
    queueCensus({
      items: Object.fromEntries([exhausted, retry, attention].map((item) => [item.key, item])),
    }),
  );
  assert.equal(projection.complete, true);
  assert.deepEqual(
    projection.items.map((item) => item.queue_disposition),
    ["parked_exhausted", "retry_scheduled", "parked"],
  );
  const stages = projection.stages;
  const zero = Object.fromEntries(Object.keys(stages!).map((key) => [key, 0]));
  const snapshot = {
    schema_version: 1,
    fleet: {},
    automatic_work: [],
    bay: {},
    diagnostics: { errors: [] },
    generated_at: new Date().toISOString(),
    workers: [],
    pipeline: [],
    exact_review_queue: {
      bay_projection: {
        ...projection,
        activity: {
          complete: true,
          total: 3,
          queue_stages: stages,
          live_stages: zero,
          queue_legacy_batch_stages: zero,
          live_legacy_batch_stages: zero,
          items: projection.items.map((item) => ({
            ...item,
            source: "queue",
            secret_note: "must-not-leak",
          })),
        },
      },
    },
  };
  const publicView = publicStatusProjection(snapshot, new Set([exhausted.decision.targetRepo]));
  const items = publicView.exact_review_queue.bay_projection.activity.items;
  assert.deepEqual(
    items.map((item) => item.queue_disposition),
    ["parked_exhausted", "retry_scheduled", "parked"],
  );
  assert.ok(!JSON.stringify(publicView).includes("must-not-leak"));
  const hidden = publicStatusProjection(snapshot, new Set());
  assert.equal(hidden.exact_review_queue.bay_projection.activity.items, undefined);
});

test("dispatch recovery exhaustion stays a neutral parked disposition", () => {
  const item = unclaimedExactReviewQueueItem(990097, "990097");
  item.state = "parked";
  item.parkedReason = "dispatch_rejected";
  item.parkedRecoveryAttempts = 3;
  item.reviewFailureAttempts = 0;
  const projection = exactReviewQueueBayProjectionFromStats(
    queueCensus({ items: Object.fromEntries([item].map((item) => [item.key, item])) }),
  );
  assert.equal(projection.items[0]?.queue_disposition, "parked");
});
