import assert from "node:assert/strict";
import test from "node:test";
import type { ExactReviewQueueState } from "../dashboard/exact-review-queue.ts";
import {
  EXACT_REVIEW_REVIEW_GENERATION_TABLE,
  EXACT_REVIEW_SOURCE_DRIFT_LOOP_RETENTION_MS,
  EXACT_REVIEW_SOURCE_DRIFT_LOOP_TABLE,
  ExactReviewReviewLoopStore,
  exactReviewSourceDriftRequeueLimit,
} from "../dashboard/exact-review-review-loop.ts";
import { summarizeDashboardHealth } from "../dashboard/dashboard-health.ts";
import { publicExactReviewQueueProjection } from "../dashboard/worker.ts";
import {
  createExactReviewAdmissionHarness,
  jsonResponse,
  withExactReviewAdmissionHarness,
} from "./dashboard-worker-harness.ts";

const repo = "openclaw/openclaw";
const marker = (number: number) => `<!-- clawsweeper-command-status:${number}:re_review:token -->`;
type Harness = ReturnType<typeof createExactReviewAdmissionHarness>;
let runCounter = 70_000;

function harness(env: Record<string, string> = {}) {
  return createExactReviewAdmissionHarness(
    () => jsonResponse({ state: "open", updated_at: "2026-09-29T00:00:00Z" }),
    { env },
  );
}

function decision(number: number, sourceAction: string, overrides: Record<string, unknown> = {}) {
  return {
    targetRepo: repo,
    targetBranch: "main",
    itemNumber: number,
    itemKind: "issue",
    sourceEvent: "issues",
    sourceAction,
    supersedesInProgress: false,
    ...overrides,
  };
}

async function post(h: Harness, path: string, body: unknown) {
  const response = await h.queue.fetch(
    new Request(`https://queue${path}`, { method: "POST", body: JSON.stringify(body) }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function enqueue(h: Harness, deliveryId: string, value: Record<string, unknown>) {
  const { status, body } = await post(h, "/enqueue", { delivery_id: deliveryId, decision: value });
  assert.equal(status, 202, JSON.stringify(body));
  return body;
}

async function queueState(h: Harness) {
  return (await h.storage.get("exact-review-queue")) as ExactReviewQueueState;
}

async function stats(h: Harness) {
  const response = await h.queue.fetch(new Request("https://queue/stats"));
  assert.equal(response.status, 200);
  return (await response.json()) as Record<string, any>;
}

/** Dispatch, claim, and successfully complete the item's current review generation. */
async function reviewOnce(h: Harness, number: number) {
  const key = `${repo}#${number}`;
  await h.queue.alarm();
  const item = (await queueState(h)).items[key];
  assert.ok(item?.leaseId, `review generation for ${key} was dispatched`);
  const tuple = {
    item_key: key,
    lease_id: item.leaseId,
    lease_revision: item.leaseRevision,
    run_id: String(runCounter++),
    run_attempt: 1,
  };
  const claim = await post(h, "/claim", tuple);
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const complete = await post(h, "/complete", {
    ...tuple,
    claim_generation: claim.body.claim_generation,
    outcome: "success",
  });
  assert.equal(complete.status, 200, JSON.stringify(complete.body));
  assert.equal((await queueState(h)).items[key], undefined, "completed generation left the queue");
  return claim.body.decision as Record<string, unknown>;
}

/** The payload sweep.yml's source-drift step sends after a remote-newer publication. */
function sourceDriftRequeue(claimed: Record<string, unknown>) {
  return { ...claimed, sourceAction: "source_drift_requeue", supersedesInProgress: true };
}

function loopRow(h: Harness, number: number) {
  return new ExactReviewReviewLoopStore(h.storage).sourceDriftLoopSync(
    `${repo}#${number}`,
    Date.now(),
  );
}

async function driveToParked(
  h: Harness,
  number: number,
  opened: Record<string, unknown> = decision(number, "opened"),
) {
  await enqueue(h, `opened-${number}`, opened);
  let claimed = await reviewOnce(h, number);
  for (let generation = 1; generation <= 3; generation += 1) {
    const admitted = await enqueue(
      h,
      `publisher-source-drift:${number}:${generation}`,
      sourceDriftRequeue(claimed),
    );
    assert.equal(admitted.queued, true, `source-drift generation ${generation} is admitted`);
    assert.equal(loopRow(h, number)?.consecutive, generation);
    claimed = await reviewOnce(h, number);
  }
  const tripped = await enqueue(
    h,
    `publisher-source-drift:${number}:4`,
    sourceDriftRequeue(claimed),
  );
  assert.deepEqual(
    {
      deduped: tripped.deduped,
      scope: tripped.dedupe_scope,
      reason: tripped.dedupe_reason,
    },
    { deduped: true, scope: "source_drift_loop", reason: "requeue_limit_reached" },
  );
  return claimed;
}

test("automatic source-drift requeues park after the limit until organic input", async () => {
  const h = harness();
  await withExactReviewAdmissionHarness(h, async () => {
    const number = 97616;
    const key = `${repo}#${number}`;
    const claimed = await driveToParked(h, number);
    const parked = (await queueState(h)).items[key]!;
    assert.equal(parked.state, "parked");
    assert.equal(parked.parkedReason, "source_drift_loop");
    const dispatches = h.dispatched.length;
    await h.queue.alarm();
    assert.equal(h.dispatched.length, dispatches, "a parked loop spends no review");

    const repeated = await enqueue(h, "publisher-source-drift:repeat", sourceDriftRequeue(claimed));
    assert.equal(repeated.dedupe_reason, "item_parked");
    const shardRecovery = await enqueue(
      h,
      "shard-recovery",
      decision(number, "failed_review_shard_recovery"),
    );
    assert.notEqual(shardRecovery.queued, true);
    assert.equal((await queueState(h)).items[key]?.parkedReason, "source_drift_loop");

    const snapshot = await stats(h);
    assert.equal(snapshot.lanes.review.parked, 1);
    assert.equal(snapshot.lanes.review.parked_reasons.source_drift_loop, 1);
    const projected = publicExactReviewQueueProjection(snapshot, new Set([repo]));
    assert.equal(projected.collection.state, "complete");
    assert.equal(projected.lanes.review.parked_reasons.source_drift_loop, 1);
    assert.equal(projected.lanes.review.parked_reasons.unknown, 0);

    // A same-time scheduled offer is not newer source and stays deduped.
    const scheduled = await enqueue(
      h,
      "scheduled-stale",
      decision(number, "scheduled_normal_backfill", {
        sourceUpdatedAt: new Date(parked.createdAt - 60_000).toISOString(),
      }),
    );
    assert.equal(scheduled.dedupe_reason, "source_drift_loop");

    const organic = await enqueue(h, "organic-edit", decision(number, "edited"));
    assert.equal(organic.queued, true);
    const released = (await queueState(h)).items[key]!;
    assert.equal(released.state, "pending");
    assert.equal(released.parkedReason, undefined);
    assert.equal(released.decision.sourceAction, "edited");
    assert.ok(released.revision > parked.revision);
    assert.equal(loopRow(h, number), null, "organic input resets the loop counter");

    const next = await reviewOnce(h, number);
    assert.equal(
      (await enqueue(h, "publisher-source-drift:after-release", sourceDriftRequeue(next))).queued,
      true,
    );
    assert.equal(loopRow(h, number)?.consecutive, 1);
  });
});

test("a newer pull request synchronize releases a parked pull request loop", async () => {
  const headA = "a".repeat(40);
  const headB = "b".repeat(40);
  let liveHead = headA;
  const h = createExactReviewAdmissionHarness(() =>
    jsonResponse({
      state: "open",
      title: "Looping PR",
      body: "",
      locked: false,
      labels: [],
      draft: false,
      head: { sha: liveHead },
      base: { sha: "c".repeat(40) },
      updated_at: "2026-09-29T00:00:00Z",
    }),
  );
  await withExactReviewAdmissionHarness(h, async () => {
    const number = 97622;
    const pr = (sourceAction: string, overrides: Record<string, unknown>) =>
      decision(number, sourceAction, {
        itemKind: "pull_request",
        sourceEvent: "pull_request",
        ...overrides,
      });
    await driveToParked(
      h,
      number,
      pr("opened", {
        sourceHeadSha: headA,
        sourceHeadVerified: true,
        sourceAuthoritySeq: 1,
        sourceUpdatedAt: "2026-09-29T00:00:00Z",
      }),
    );
    const parked = (await queueState(h)).items[`${repo}#${number}`]!;
    assert.equal(parked.parkedReason, "source_drift_loop");
    liveHead = headB;
    const synchronize = await enqueue(
      h,
      "pr-synchronize",
      pr("synchronize", {
        supersedesInProgress: true,
        sourceHeadSha: headB,
        sourceHeadVerified: true,
        sourceAuthoritySeq: 2,
        sourceUpdatedAt: "2026-09-29T01:00:00Z",
      }),
    );
    assert.equal(synchronize.queued, true);
    const released = (await queueState(h)).items[`${repo}#${number}`]!;
    assert.equal(released.state, "pending");
    assert.equal(released.decision.sourceHeadSha, headB);
    assert.equal(released.decision.sourceAction, "synchronize");
    assert.equal(loopRow(h, number), null);
  });
});

test("operators can list and recover a parked loop, restarting its budget", async () => {
  const h = harness();
  await withExactReviewAdmissionHarness(h, async () => {
    const number = 97623;
    await driveToParked(h, number);
    const listed = await post(h, "/parked-reviews/list", { limit: 10 });
    const row = listed.body.parked_reviews.find(
      (entry: Record<string, unknown>) => entry.item_key === `${repo}#${number}`,
    );
    assert.equal(row?.parked_reason, "source_drift_loop");
    const recovered = await post(h, "/parked-reviews/recover-fresh", {
      idempotency_key: "operator-loop-recovery",
      override_retry_budget: true,
      items: [row],
    });
    assert.equal(recovered.body.recovered, 1, JSON.stringify(recovered.body));
    assert.equal((await queueState(h)).items[`${repo}#${number}`]?.state, "pending");
    assert.equal(loopRow(h, number), null);
  });
});

test("an explicit command releases a parked loop", async () => {
  const h = harness();
  await withExactReviewAdmissionHarness(h, async () => {
    const commandNumber = 97617;
    await driveToParked(h, commandNumber);
    const command = await enqueue(
      h,
      "command-re-review",
      decision(commandNumber, "re_review", {
        commandStatusMarker: marker(commandNumber),
        statusCommentId: 9001,
      }),
    );
    assert.equal(command.queued, true);
    const commanded = (await queueState(h)).items[`${repo}#${commandNumber}`]!;
    assert.equal(commanded.state, "pending");
    assert.equal(commanded.decision.commandStatusMarker, marker(commandNumber));
    assert.equal(loopRow(h, commandNumber), null);
  });
});

test("a newer scheduled offer releases one review without resetting the loop", async () => {
  const h = harness();
  await withExactReviewAdmissionHarness(h, async () => {
    const scheduledNumber = 97618;
    const key = `${repo}#${scheduledNumber}`;
    await driveToParked(h, scheduledNumber);
    const parked = (await queueState(h)).items[key]!;
    const scheduled = await enqueue(
      h,
      "scheduled-newer",
      decision(scheduledNumber, "scheduled_normal_backfill", {
        sourceUpdatedAt: new Date(parked.createdAt + 60_000).toISOString(),
      }),
    );
    assert.equal(scheduled.queued, true);
    const replaced = (await queueState(h)).items[key]!;
    assert.equal(replaced.state, "pending");
    assert.equal(replaced.decision.sourceAction, "scheduled_normal_backfill");
    assert.ok(replaced.revision > parked.revision);
    assert.equal(loopRow(h, scheduledNumber)?.consecutive, 3, "scheduled release keeps the count");

    // The one released review ends in another drift requeue: it re-parks at
    // once instead of spending three more generations.
    const dispatches = h.dispatched.length;
    const released = await reviewOnce(h, scheduledNumber);
    assert.equal(h.dispatched.length, dispatches + 1);
    const reparked = await enqueue(
      h,
      "publisher-source-drift:after-scheduled",
      sourceDriftRequeue(released),
    );
    assert.equal(reparked.dedupe_reason, "requeue_limit_reached");
    const again = (await queueState(h)).items[key]!;
    assert.equal(again.parkedReason, "source_drift_loop");
    await h.queue.alarm();
    assert.equal(h.dispatched.length, dispatches + 1, "no further review after re-park");

    // The re-parked row needs another offer newer than its own park.
    const stale = await enqueue(
      h,
      "scheduled-stale-after-repark",
      decision(scheduledNumber, "scheduled_normal_backfill", {
        sourceUpdatedAt: new Date(again.createdAt - 1_000).toISOString(),
      }),
    );
    assert.equal(stale.dedupe_reason, "source_drift_loop");
    assert.equal(loopRow(h, scheduledNumber)?.consecutive, 3);
  });
});

test("an expired exhausted counter never denies admission and is not resurrected", async () => {
  const h = harness();
  await withExactReviewAdmissionHarness(h, async () => {
    const number = 97624;
    const key = `${repo}#${number}`;
    const store = new ExactReviewReviewLoopStore(h.storage);
    store.ensureSchemaSync();
    const stale = Date.now() - EXACT_REVIEW_SOURCE_DRIFT_LOOP_RETENTION_MS - 60_000;
    const seed = () =>
      h.storage.sql.exec(
        `INSERT OR REPLACE INTO ${EXACT_REVIEW_SOURCE_DRIFT_LOOP_TABLE}
           (item_key, consecutive, updated_at) VALUES (?, 3, ?)`,
        key,
        stale,
      );
    // Parking must not refresh an expired row back to life.
    seed();
    store.markSourceDriftLoopParkedSync(key, Date.now());
    const stored = () =>
      Array.from(
        h.storage.sql.exec(
          `SELECT consecutive, updated_at FROM ${EXACT_REVIEW_SOURCE_DRIFT_LOOP_TABLE} WHERE item_key = ?`,
          key,
        ),
      )[0] as { consecutive: number; updated_at: number } | undefined;
    assert.equal(stored()?.updated_at, stale);
    assert.equal(store.sourceDriftLoopSync(key, Date.now()), null, "expired counter reads absent");
    assert.equal(stored(), undefined, "expired lookup deletes the row");

    // The live path: an exhausted counter older than retention, with no
    // pruning write in between, admits the next drift requeue as generation 1.
    seed();
    const admitted = await enqueue(
      h,
      "source-drift-after-idle",
      decision(number, "source_drift_requeue", { supersedesInProgress: true }),
    );
    assert.equal(admitted.queued, true, JSON.stringify(admitted));
    assert.equal((await queueState(h)).items[key]?.state, "pending");
    assert.equal(loopRow(h, number)?.consecutive, 1);

    // The bounded prune cannot leave an expired count to be incremented.
    seed();
    assert.equal(store.recordSourceDriftGenerationSync(key, Date.now()), 1);
  });
});

test("command-context source-drift requeues are never counted or parked", async () => {
  const h = harness();
  await withExactReviewAdmissionHarness(h, async () => {
    const number = 97619;
    const store = new ExactReviewReviewLoopStore(h.storage);
    for (let index = 0; index < 5; index += 1) {
      store.recordSourceDriftGenerationSync(`${repo}#${number}`, Date.now());
    }
    const admitted = await enqueue(
      h,
      "command-source-drift",
      decision(number, "source_drift_requeue", {
        commandStatusMarker: marker(number),
        statusCommentId: 9002,
      }),
    );
    assert.equal(admitted.queued, true);
    const item = (await queueState(h)).items[`${repo}#${number}`]!;
    assert.equal(item.state, "pending");
    assert.equal(loopRow(h, number)?.consecutive, 5, "command continuations do not count");
  });
});

test("a zero limit disables the breaker", async () => {
  assert.equal(exactReviewSourceDriftRequeueLimit({}), 3);
  assert.equal(
    exactReviewSourceDriftRequeueLimit({ EXACT_REVIEW_SOURCE_DRIFT_REQUEUE_LIMIT: "" }),
    3,
  );
  assert.equal(
    exactReviewSourceDriftRequeueLimit({ EXACT_REVIEW_SOURCE_DRIFT_REQUEUE_LIMIT: "x" }),
    3,
  );
  const h = harness({ EXACT_REVIEW_SOURCE_DRIFT_REQUEUE_LIMIT: "0" });
  await withExactReviewAdmissionHarness(h, async () => {
    const number = 97620;
    await enqueue(h, "opened", decision(number, "opened"));
    let claimed = await reviewOnce(h, number);
    for (let generation = 1; generation <= 5; generation += 1) {
      const admitted = await enqueue(h, `sd-${generation}`, sourceDriftRequeue(claimed));
      assert.equal(admitted.queued, true, `generation ${generation}`);
      claimed = await reviewOnce(h, number);
    }
  });
});

test("runaway review generations degrade queue health with public-only samples", async () => {
  const h = harness({ EXACT_REVIEW_RUNAWAY_REVIEWS_PER_DAY: "4" });
  await withExactReviewAdmissionHarness(h, async () => {
    const healthy = await stats(h);
    assert.deepEqual(healthy.review_runaway_health, {
      status: "healthy",
      reason: null,
      window_hours: 24,
      threshold_reviews_per_day: 4,
      runaway_items: 0,
      sample_item_keys: [],
    });
    const number = 97621;
    await enqueue(h, "runaway-opened", decision(number, "opened"));
    await reviewOnce(h, number);
    for (let edit = 1; edit <= 4; edit += 1) {
      await enqueue(h, `runaway-edit-${edit}`, decision(number, "edited"));
      await reviewOnce(h, number);
    }
    // A private repository's runaway counts, but its key is never public.
    new ExactReviewReviewLoopStore(h.storage).ensureSchemaSync();
    for (let run = 0; run < 6; run += 1) {
      h.storage.sql.exec(
        `INSERT INTO ${EXACT_REVIEW_REVIEW_GENERATION_TABLE}
           (item_key, run_id, run_attempt, claimed_at) VALUES (?, ?, 1, ?)`,
        "openclaw/private-repo#5",
        String(90_000 + run),
        Date.now(),
      );
    }
    const snapshot = await stats(h);
    assert.deepEqual(snapshot.review_runaway_health, {
      status: "degraded",
      reason: "review_runaway",
      window_hours: 24,
      threshold_reviews_per_day: 4,
      runaway_items: 2,
      sample_item_keys: ["openclaw/private-repo#5", `${repo}#${number}`],
    });
    const projected = publicExactReviewQueueProjection(snapshot, new Set([repo]));
    assert.equal(projected.collection.state, "complete");
    assert.deepEqual(projected.review_runaway_health, {
      status: "degraded",
      reason: "review_runaway",
      window_hours: 24,
      threshold_reviews_per_day: 4,
      runaway_items: 2,
      sample_item_keys: [`${repo}#${number}`],
    });
    assert.deepEqual(publicExactReviewQueueProjection(projected, new Set([repo])), projected);
    assert.deepEqual(
      summarizeDashboardHealth({ exact_review_queue: snapshot }).reasons.includes("review_runaway"),
      true,
    );

    // Generations age out of the trailing 24-hour window.
    h.storage.sql.exec(
      `UPDATE ${EXACT_REVIEW_REVIEW_GENERATION_TABLE} SET claimed_at = claimed_at - ?`,
      25 * 60 * 60 * 1000,
    );
    assert.equal((await stats(h)).review_runaway_health.status, "healthy");
  });
});

test("public runaway projection fails closed on malformed or absent input", () => {
  const valid = {
    status: "degraded",
    reason: "review_runaway",
    window_hours: 24,
    threshold_reviews_per_day: 24,
    runaway_items: 1,
    sample_item_keys: [`${repo}#1`],
  };
  const project = (review_runaway_health: unknown) =>
    publicExactReviewQueueProjection({ review_runaway_health }, new Set([repo]))
      .review_runaway_health;
  assert.deepEqual(project(valid), valid);
  assert.equal(project(undefined), null);
  for (const malformed of [
    { ...valid, status: "critical" },
    { ...valid, reason: null },
    { ...valid, runaway_items: 0 },
    { ...valid, sample_item_keys: ["https://github.com/openclaw/openclaw/issues/1"] },
    { ...valid, sample_item_keys: "openclaw/openclaw#1" },
    { ...valid, threshold_reviews_per_day: 0 },
  ]) {
    assert.equal(project(malformed), null, JSON.stringify(malformed));
  }
  assert.deepEqual(
    project({
      ...valid,
      runaway_items: 7,
      sample_item_keys: Array.from({ length: 7 }, (_, index) => `${repo}#${index + 1}`),
    })?.sample_item_keys,
    [1, 2, 3, 4, 5].map((index) => `${repo}#${index}`),
  );
});
