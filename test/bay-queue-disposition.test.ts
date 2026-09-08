import assert from "node:assert/strict";
import test from "node:test";
import { exactReviewQueueBayProjection } from "../dashboard/exact-review-read-model.ts";
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
    parkedReason: "dead_letter_capacity",
  };
  const projection = exactReviewQueueBayProjection([exhausted, retry, attention] as never);
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

test("browser reference sanitizer preserves only bounded queue dispositions", async () => {
  const { bayHtml } = await import("../dashboard/bay-page.ts");
  const { runInNewContext } = await import("node:vm");
  const html = bayHtml();
  const names = [
    "bayObject",
    "strictBayCount",
    "strictBayTimestamp",
    "strictBayRepository",
    "strictBayItemNumber",
    "strictBayAction",
    "strictBayReferenceTiming",
    "strictBayReference",
  ];
  const source = names
    .map((name) => {
      const line = html
        .split("\n")
        .find((line) => line.trimStart().startsWith(`function ${name}(`));
      assert.ok(line, name);
      return line;
    })
    .join("\n");
  const parse = runInNewContext(source + "\nstrictBayReference", {
    STAGES: ["repairing", "reviewing"],
    MAX_BAY_COUNT: 10000,
  });
  const base = {
    repository: "openclaw/gogcli",
    item_number: 990001,
    stage: "repairing",
    source: "queue",
    legacy_batch_path: false,
  };
  for (const disposition of ["parked_exhausted", "parked", "retry_scheduled"]) {
    assert.equal(
      parse({ ...base, queue_disposition: disposition }, false).queue_disposition,
      disposition,
    );
  }
  for (const disposition of ["__proto__", "private-debug-value", 42, null]) {
    assert.equal(
      parse({ ...base, queue_disposition: disposition }, false).queue_disposition,
      undefined,
    );
  }
  assert.equal(
    parse({ ...base, source: "live", queue_disposition: "parked_exhausted" }, false)
      .queue_disposition,
    undefined,
  );
});
