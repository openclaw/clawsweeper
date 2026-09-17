import {
  assert,
  test,
  ExactReviewQueue,
  MemoryDurableStorage,
  leasedExactReviewQueueItem,
} from "./dashboard-worker-harness.ts";
import { publicStatusProjection } from "../dashboard/worker.ts";
import { exactReviewQueueBayProjection } from "../dashboard/exact-review-read-model.ts";
import {
  currentReviewFailure,
  reviewFailureDecisionFingerprint,
  clearStaleReviewFailure,
} from "../dashboard/exact-review-observed-failure.ts";
import type {
  ExactReviewQueueItem,
  ExactReviewQueueState,
} from "../dashboard/exact-review-queue.ts";

const known = { stage: "source_preparation", reason: "review_history_unavailable" } as const;
async function completed(supplied: unknown, newer = false) {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewQueueItem(990021, "990021") as ExactReviewQueueItem;
  item.reviewFailureAttempts = 7;
  item.parkedRecoveryAttempts = 3;
  if (newer) {
    item.revision++;
    item.decision = { ...item.decision, sourceAction: "edited", statusCommentId: 990029 };
  }
  await storage.put("exact-review-queue", { items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});
  const response = await queue.fetch(
    new Request("https://queue/complete", {
      method: "POST",
      body: JSON.stringify({
        item_key: item.key,
        lease_id: item.leaseId,
        lease_revision: 1,
        claim_generation: 1,
        run_id: "990021",
        run_attempt: 1,
        outcome: "failure",
        ...(supplied === undefined ? {} : { review_failure: supplied }),
      }),
    }),
  );
  return { storage, queue, response, item };
}

test("observed failure persists through completion and DO restart and projects only its safe pair", async () => {
  const h = await completed({ stage: known.stage, reason_code: known.reason, retryable: true });
  assert.equal(h.response.status, 200, await h.response.clone().text());
  const state = (await h.storage.get("exact-review-queue")) as ExactReviewQueueState;
  assert.equal(state.items[h.item.key].state, "parked");
  assert.deepEqual(state.items[h.item.key].reviewFailure, known);
  const restored = new ExactReviewQueue({ storage: h.storage }, {});
  const stats = await (await restored.fetch(new Request("https://queue/stats"))).json();
  assert.deepEqual(stats.bay_projection.items[0].review_failure, known);
  assert.equal(state.items[h.item.key].reviewFailureAttempts, 8);
  assert.equal(state.items[h.item.key].parkedRecoveryAttempts, 3);
});

test("old lease, invalid diagnostics and absent legacy metadata cannot invent a successor cause", async () => {
  const newer = await completed(
    { stage: known.stage, reason_code: known.reason, retryable: true },
    true,
  );
  assert.equal(newer.response.status, 200);
  const state = (await newer.storage.get("exact-review-queue")) as ExactReviewQueueState;
  assert.equal(state.items[newer.item.key].reviewFailure, undefined);
  for (const detail of [
    { stage: "private/path", reason_code: "secret", retryable: true },
    { stage: "source_preparation", reason_code: "private/path", retryable: true },
  ]) {
    const h = await completed(detail);
    assert.equal(h.response.status, 400);
    const unchanged = (await h.storage.get("exact-review-queue")) as ExactReviewQueueState;
    assert.equal(unchanged.items[h.item.key].reviewFailure, undefined);
  }
  const legacy = await completed(undefined);
  const legacyState = (await legacy.storage.get("exact-review-queue")) as ExactReviewQueueState;
  assert.equal(legacyState.items[legacy.item.key].reviewFailure, undefined);
  const examples = [120887, 131455, 131604, 131464].map((n) => {
    const item = leasedExactReviewQueueItem(n, String(n)) as ExactReviewQueueItem;
    item.state = "parked";
    item.parkedReason = "review_retry_exhausted";
    item.reviewFailureAttempts = 8;
    item.parkedRecoveryAttempts = 3;
    return item;
  });
  for (const item of exactReviewQueueBayProjection(examples).items!)
    assert.equal(item.review_failure, undefined);
});

test("source or command changes clear durable cause while matching identity survives", () => {
  for (const change of [
    { sourceHeadSha: "b".repeat(40) },
    { statusCommentId: 990022 },
    { commandStatusMarker: "new command" },
  ]) {
    const item = leasedExactReviewQueueItem(990021, "990021") as ExactReviewQueueItem;
    item.reviewFailure = known;
    item.reviewFailureDecisionFingerprint = reviewFailureDecisionFingerprint(item.decision);
    assert.deepEqual(currentReviewFailure(item), known);
    item.decision = { ...item.decision, ...change };
    assert.equal(currentReviewFailure(item), null);
    clearStaleReviewFailure(item);
    assert.equal(item.reviewFailure, undefined);
    assert.equal(item.reviewFailureDecisionFingerprint, undefined);
  }
});

test("Worker public projection only includes safe failure pairs for allowed queue references", () => {
  const item = leasedExactReviewQueueItem(990021, "990021") as ExactReviewQueueItem;
  item.state = "parked";
  item.parkedReason = "review_retry_exhausted";
  item.parkedRecoveryAttempts = 3;
  item.reviewFailure = known;
  item.reviewFailureDecisionFingerprint = reviewFailureDecisionFingerprint(item.decision);
  const projection = exactReviewQueueBayProjection([item]);
  const stages = projection.stages!;
  const zero = Object.fromEntries(Object.keys(stages).map((k) => [k, 0]));
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
          total: 1,
          queue_stages: stages,
          live_stages: zero,
          queue_legacy_batch_stages: zero,
          live_legacy_batch_stages: zero,
          items: projection.items!.map((i) => ({
            ...i,
            source: "queue",
            secret_note: "private/path",
          })),
        },
      },
    },
  };
  const allowed = new Set([item.decision.targetRepo]);
  const publicItems = () =>
    publicStatusProjection(snapshot, allowed).exact_review_queue.bay_projection.activity.items;
  assert.deepEqual(publicItems()[0].review_failure, known);
  assert.ok(!JSON.stringify(publicItems()).includes("private/path"));
  const ref = snapshot.exact_review_queue.bay_projection.activity.items[0];
  for (const invalid of [
    { stage: "workflow", reason: "private/path" },
    { ...known, raw: "private/path" },
    "private/path",
  ]) {
    ref.review_failure = invalid as never;
    assert.equal(publicItems()[0].review_failure, undefined);
  }
  ref.review_failure = known;
  ref.source = "live";
  assert.equal(publicItems()[0].review_failure, undefined);
  const hidden = publicStatusProjection(snapshot, new Set());
  assert.ok(!JSON.stringify(hidden).includes(known.reason));
});

test("provider stages collapse to public vocabulary and raw supplemental diagnostics are discarded", async () => {
  const h = await completed({
    stage: "timeout",
    reason_code: "timeout",
    retryable: true,
    raw_error: "private/path/token",
  });
  assert.equal(h.response.status, 200);
  const state = (await h.storage.get("exact-review-queue")) as ExactReviewQueueState;
  assert.deepEqual(state.items[h.item.key].reviewFailure, {
    stage: "provider_or_model",
    reason: "timeout",
  });
  assert.ok(!JSON.stringify(state.items[h.item.key]).includes("private/path/token"));
});

test("successful completion clears a previous failure even when latest-source requeue retains the slot", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewQueueItem(990021, "990021") as ExactReviewQueueItem;
  item.reviewFailure = known;
  item.reviewFailureDecisionFingerprint = reviewFailureDecisionFingerprint(item.decision);
  await storage.put("exact-review-queue", { items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});
  const result = await queue.fetch(
    new Request("https://queue/complete", {
      method: "POST",
      body: JSON.stringify({
        item_key: item.key,
        lease_id: item.leaseId,
        lease_revision: 1,
        claim_generation: 1,
        run_id: "990021",
        run_attempt: 1,
        outcome: "success",
        requeue_latest: true,
      }),
    }),
  );
  assert.equal(result.status, 200, await result.clone().text());
  const state = (await storage.get("exact-review-queue")) as ExactReviewQueueState;
  assert.equal(state.items[item.key].state, "pending");
  assert.equal(state.items[item.key].reviewFailure, undefined);
  assert.equal(state.items[item.key].reviewFailureDecisionFingerprint, undefined);
});
