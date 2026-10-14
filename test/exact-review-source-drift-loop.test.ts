import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  EXACT_REVIEW_REVIEW_GENERATION_TABLE,
  EXACT_REVIEW_SOURCE_DRIFT_LOOP_RETENTION_MS,
  EXACT_REVIEW_SOURCE_DRIFT_LOOP_TABLE,
  ExactReviewReviewLoopStore,
  exactReviewSourceDriftRequeueLimit,
} from "../dashboard/exact-review-review-loop.ts";
import { summarizeDashboardHealth } from "../dashboard/dashboard-health.ts";
import { ExactReviewLifecycleProjectionStore } from "../dashboard/exact-review-lifecycle.ts";
import { publicExactReviewQueueProjection } from "../dashboard/worker.ts";
import { isExplicitReviewRequest } from "../src/maintainer-review-policy.ts";
import {
  createExactReviewAdmissionHarness,
  jsonResponse,
  withExactReviewAdmissionHarness,
} from "./dashboard-worker-harness.ts";
import {
  DEFERRED_CONTINUATION_SCENARIOS,
  claimPublication,
  decision,
  deferredContinuationClaim,
  deferredPublication,
  enqueue,
  harness,
  post,
  queueState,
  repo,
  reviewOnce,
  sourceDriftRequeue,
  verifiedRequest,
  type DeferredContinuationScenario,
  type Harness,
} from "./exact-review-deferred-publication-fixture.ts";

const marker = (number: number) => `<!-- clawsweeper-command-status:${number}:re_review:token -->`;
async function stats(h: Harness) {
  const response = await h.queue.fetch(new Request("https://queue/stats"));
  assert.equal(response.status, 200);
  return (await response.json()) as Record<string, any>;
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

test("command-context source-drift requeues are never shed", async () => {
  const continuation = (number: number) =>
    decision(number, "source_drift_requeue", {
      supersedesInProgress: true,
      commandStatusMarker: marker(number),
      statusCommentId: number,
    });
  const plain = (number: number) =>
    decision(number, "source_drift_requeue", { supersedesInProgress: true });

  const backpressure = harness({ EXACT_REVIEW_PENDING_SOFT_LIMIT: "1" });
  await withExactReviewAdmissionHarness(backpressure, async () => {
    await enqueue(backpressure, "fills-soft-limit", decision(97630, "opened"));
    assert.deepEqual(await enqueue(backpressure, "plain-backpressure", plain(97631)), {
      ok: true,
      shed: true,
      reason: "backpressure",
    });
    const admitted = await enqueue(backpressure, "command-backpressure", continuation(97632));
    assert.equal(admitted.queued, true, JSON.stringify(admitted));
    assert.equal((await queueState(backpressure)).items[`${repo}#97632`]?.state, "pending");
  });

  // A GitHub throttle window holds plain recovery, not a command continuation.
  const throttled = harness();
  await withExactReviewAdmissionHarness(throttled, async () => {
    const now = Date.now();
    throttled.storage.kv.put("exact-review-scheduled-feed:v1:global", {
      tokens: 0,
      updatedAt: now,
      throttleObservedAt: now,
      throttleUntil: now + 60 * 60_000,
      throttleSource: "review_run",
    });
    assert.deepEqual(await enqueue(throttled, "plain-throttle", plain(97633)), {
      ok: true,
      shed: true,
      reason: "scheduled_rate",
    });
    const admitted = await enqueue(throttled, "command-throttle", continuation(97634));
    assert.equal(admitted.queued, true, JSON.stringify(admitted));
    assert.equal((await queueState(throttled)).items[`${repo}#97634`]?.state, "pending");
  });
});

test("a source-drift requeue of a finished request keeps its status but not its authority", async () => {
  const h = harness();
  await withExactReviewAdmissionHarness(h, async () => {
    const number = 97621;
    await enqueue(h, "request", verifiedRequest(number, 6150293296));
    const claimed = await reviewOnce(h, number);
    assert.equal(isExplicitReviewRequest(claimed), true);

    // A publisher requeue or replay arriving after the request's generation finished.
    await enqueue(h, "late-source-drift", sourceDriftRequeue(claimed));
    const item = (await queueState(h)).items[`${repo}#${number}`]!;
    assert.equal(item.decision.commandStatusMarker, claimed.commandStatusMarker);
    assert.equal(item.decision.sourceCommentVerified, undefined);
    assert.equal(isExplicitReviewRequest(item.decision), false);
    assert.equal(isExplicitReviewRequest(await reviewOnce(h, number)), false);
  });
});

test("a caller cannot claim the queue-owned in-place requeue provenance", async () => {
  const h = harness();
  await withExactReviewAdmissionHarness(h, async () => {
    const number = 97625;
    await enqueue(h, "request", verifiedRequest(number, 4001));
    const claimed = await reviewOnce(h, number);

    const forged = await post(h, "/enqueue", {
      delivery_id: `direct-lifecycle-requeue:${repo}#${number}:1`,
      decision: sourceDriftRequeue(claimed),
    });
    assert.deepEqual(forged, { status: 400, body: { error: "reserved_delivery_id" } });
    assert.equal((await queueState(h)).items[`${repo}#${number}`], undefined);
  });
});

test("a source-drift requeue of a replaced request leaves the newer request queued", async () => {
  const h = harness();
  await withExactReviewAdmissionHarness(h, async () => {
    const number = 97622;
    await enqueue(h, "first-request", verifiedRequest(number, 1001));
    const first = await reviewOnce(h, number);
    const newer = {
      ...verifiedRequest(number, 1002),
      sourceCommentUpdatedAt: "2026-10-13T16:40:00Z",
    };
    await enqueue(h, "newer-request", newer);

    const admitted = await enqueue(h, "stale-source-drift", sourceDriftRequeue(first));
    assert.equal(admitted.queued, true);
    const item = (await queueState(h)).items[`${repo}#${number}`]!;
    assert.equal(item.decision.sourceAction, "re_review");
    assert.equal(item.decision.commandStatusMarker, newer.commandStatusMarker);
    assert.equal(item.decision.sourceCommentId, 1002);
  });
});

test("a verified requeue persisted by the previous release keeps authority only in place", async () => {
  for (const inPlace of [false, true]) {
    const h = harness();
    await withExactReviewAdmissionHarness(h, async () => {
      const number = inPlace ? 97624 : 97623;
      const key = `${repo}#${number}`;
      await enqueue(h, "request", verifiedRequest(number, 3001));
      const claimed = await reviewOnce(h, number);
      await enqueue(h, `publisher-source-drift:${number}:1`, sourceDriftRequeue(claimed));
      // Restore the row as the previous release stored it: verification intact.
      const [row] = Array.from(
        h.storage.sql.exec(
          "SELECT item_json FROM exact_review_queue_items WHERE item_key = ?",
          key,
        ) as Iterable<{ item_json: string }>,
      );
      const stored = JSON.parse(row!.item_json);
      stored.decision.sourceCommentVerified = true;
      if (inPlace) stored.admissionDeliveryId = `direct-lifecycle-requeue:${key}:1`;
      h.storage.sql.exec(
        "UPDATE exact_review_queue_items SET item_json = ? WHERE item_key = ?",
        JSON.stringify(stored),
        key,
      );
      assert.equal(isExplicitReviewRequest(await reviewOnce(h, number)), inPlace);
    });
  }
});

test("a deferred publisher's source-drift requeue continues the open request", async () => {
  const h = harness();
  await withExactReviewAdmissionHarness(h, async () => {
    const deferred = await deferredPublication(h, verifiedRequest(97640, 6150293297));
    assert.equal(isExplicitReviewRequest(deferred.claimed), true);
    await claimPublication(h, deferred.publicationKey);

    // Callers cannot claim the queue-owned continuation prefixes.
    for (const forged of ["held-publication-requeue:x", "direct-lifecycle-requeue:x"]) {
      const response = await post(h, "/enqueue", {
        delivery_id: forged,
        decision: sourceDriftRequeue(deferred.claimed),
      });
      assert.deepEqual(response, { status: 400, body: { error: "reserved_delivery_id" } });
    }

    await enqueue(h, deferred.requeueDeliveryId, sourceDriftRequeue(deferred.claimed));
    const item = (await queueState(h)).items[deferred.key]!;
    assert.equal(item.decision.sourceAction, "source_drift_requeue");
    assert.equal(item.decision.sourceCommentVerified, true);
    assert.equal(
      item.admissionDeliveryId,
      `held-publication-requeue:${deferred.requeueDeliveryId}`,
    );
    // The review job receives this decision as CLAIM_DECISION, after the
    // load-time rule has run.
    assert.equal(isExplicitReviewRequest(await reviewOnce(h, 97640)), true);
  });
});

test("a deferred continuation follows a publication refreshed under its retained key", async () => {
  const h = harness();
  await withExactReviewAdmissionHarness(h, async () => {
    const number = 97650;
    const deferred = await deferredPublication(h, verifiedRequest(number, 6150293310));
    // A rerun of the same review generation delivers its artifact again. Same-
    // lineage deduplication keeps the queue key and refreshes its producer.
    const { publication } = deferred.publicationDecision;
    const rerun = await enqueue(h, `publisher:${deferred.producerRunId}:2`, {
      ...deferred.publicationDecision,
      publication: {
        ...publication,
        artifactName: `exact-review-${deferred.producerRunId}-2`,
        producerRunAttempt: 2,
      },
    });
    assert.equal(rerun.semantic_deduped, true, JSON.stringify(rerun));
    const retained = (await queueState(h)).items[deferred.publicationKey]!;
    assert.equal(retained.decision.publication?.producerRunAttempt, 2);
    await claimPublication(h, deferred.publicationKey);

    // The publisher names the refreshed producer it claimed.
    await enqueue(
      h,
      `publisher-source-drift:${deferred.producerRunId}:2`,
      sourceDriftRequeue(deferred.claimed),
    );
    const item = (await queueState(h)).items[deferred.key]!;
    assert.equal(item.decision.sourceCommentVerified, true);
    assert.equal(isExplicitReviewRequest(await reviewOnce(h, number)), true);
  });
});

test("a deferred source-drift requeue loses authority once the request is answered or replaced", async () => {
  const revoked = (
    Object.keys(DEFERRED_CONTINUATION_SCENARIOS) as DeferredContinuationScenario[]
  ).filter((scenario) => scenario !== "open");
  for (const [index, scenario] of revoked.entries()) {
    const { requested, stored, claimed } = await deferredContinuationClaim(scenario, 97641 + index);
    assert.equal(stored.decision.commandStatusMarker, requested.commandStatusMarker, scenario);
    assert.equal(stored.decision.sourceCommentVerified, undefined, scenario);
    assert.equal(claimed.commandStatusMarker, requested.commandStatusMarker, scenario);
    assert.equal(isExplicitReviewRequest(claimed), false, scenario);
  }
});

/** sweep.yml's publication completion after it queued the source-drift requeue. */
function requeueCompletion(publisher: Record<string, unknown>) {
  return {
    ...publisher,
    outcome: "success",
    completion_kind: "superseded",
    reason_code: "live_terminal",
    lifecycle_terminal_disposition: "requeue",
  };
}

function lifecycleAt(h: Harness, number: number, fenceKey: string, revision: number) {
  return new ExactReviewLifecycleProjectionStore(h.storage).read(
    `${repo}#${number}`,
    fenceKey,
    revision,
  );
}

/** An organic event after the request's review finished, so its item has no request. */
function organicEdit(number: number) {
  return decision(number, "edited", { sourceUpdatedAt: "2026-10-13T16:45:00Z" });
}

/** Queue an organic review and claim its lease, as its review run would. */
async function claimOrganicReview(h: Harness, number: number) {
  await enqueue(h, "organic-edit", organicEdit(number));
  await h.queue.alarm();
  const active = (await queueState(h)).items[`${repo}#${number}`]!;
  const tuple = {
    item_key: active.key,
    lease_id: active.leaseId,
    lease_revision: active.leaseRevision,
    run_id: String(8_000_000 + number),
    run_attempt: 1,
  };
  const claim = await post(h, "/claim", tuple);
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  return { ...tuple, claim_generation: claim.body.claim_generation };
}

test("a deferred requeue hands the open request to a pending review queued for newer source", async () => {
  // The production debounce keeps the organic review pending.
  const h = harness({ EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "90000" });
  await withExactReviewAdmissionHarness(h, async () => {
    const number = 97650;
    const deferred = await deferredPublication(h, {
      ...verifiedRequest(number, 6150293500),
      statusCommentId: 7650,
    });
    await enqueue(h, "organic-edit", organicEdit(number));
    const publisher = await claimPublication(h, deferred.publicationKey);
    const queued = (await queueState(h)).items[deferred.key]!;
    assert.equal(queued.state, "pending");
    assert.equal(queued.decision.commandStatusMarker, undefined);

    const requeued = await enqueue(
      h,
      deferred.requeueDeliveryId,
      sourceDriftRequeue(deferred.claimed),
    );
    assert.equal(requeued.queued, true, JSON.stringify(requeued));
    const carried = (await queueState(h)).items[deferred.key]!;
    assert.equal(carried.state, "pending");
    assert.ok(carried.revision > queued.revision);
    assert.equal(
      carried.admissionDeliveryId,
      `held-publication-requeue:${deferred.requeueDeliveryId}`,
    );
    // The queued review keeps its newer source and takes over the request.
    assert.equal(carried.decision.sourceUpdatedAt, "2026-10-13T16:45:00Z");
    assert.equal(carried.decision.sourceAction, "source_drift_requeue");
    for (const field of [
      "commandStatusMarker",
      "statusCommentId",
      "sourceCommentId",
      "sourceCommentUpdatedAt",
      "commandBodyDigest",
      "commandOrigin",
      "sourceCommentVerified",
    ]) {
      assert.equal(carried.decision[field], deferred.claimed[field], field);
    }
    assert.equal(carried.nextAttemptAt <= Date.now(), true, "a request is not debounced");
    const admission = lifecycleAt(h, number, deferred.key, carried.revision)?.admission;
    assert.equal(admission?.commandOriginated, true);
    assert.equal(admission?.statusMarker, deferred.claimed.commandStatusMarker);

    // The publication's requeue stands: the queued review owns the request now.
    const completed = await post(h, "/complete", requeueCompletion(publisher));
    assert.deepEqual(completed, { status: 200, body: { ok: true, requeued: false } });
    assert.equal(
      lifecycleAt(h, number, deferred.publicationKey, publisher.lease_revision as number)
        ?.terminalDisposition?.kind,
      "requeue",
    );
    const keys = Object.keys((await queueState(h)).items);
    assert.deepEqual(keys, [deferred.key]);

    const claimed = await reviewOnce(h, number);
    assert.equal(isExplicitReviewRequest(claimed), true);
    assert.equal(claimed.commandStatusMarker, deferred.claimed.commandStatusMarker);
    assert.equal(claimed.sourceUpdatedAt, "2026-10-13T16:45:00Z");
  });
});

test("a deferred requeue naming another producer leaves the pending review untouched", async () => {
  const h = harness({ EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "90000" });
  await withExactReviewAdmissionHarness(h, async () => {
    const number = 97651;
    const deferred = await deferredPublication(h, verifiedRequest(number, 6150293501));
    await enqueue(h, "organic-edit", organicEdit(number));
    await claimPublication(h, deferred.publicationKey);
    const queued = structuredClone((await queueState(h)).items[deferred.key]!);

    // Only the producer that still holds its own publication may hand over its request.
    const forgedProducer = deferred.requeueDeliveryId.replace(/:(\d+):(\d+)$/, ":999999:$2");
    assert.notEqual(forgedProducer, deferred.requeueDeliveryId);
    await enqueue(h, forgedProducer, sourceDriftRequeue(deferred.claimed));
    const untouched = (await queueState(h)).items[deferred.key]!;
    // Still the debounced organic review, without the request.
    assert.deepEqual(untouched, queued);
    assert.equal(isExplicitReviewRequest(untouched.decision), false);
  });
});

test("a deferred requeue leaves other queued reviews untouched and answers the request", async (t) => {
  const scenarios: Array<{
    name: string;
    env?: Record<string, string>;
    // Runs after the publisher holds the publication.
    queue: (h: Harness, number: number) => Promise<void>;
  }> = [
    {
      name: "active review",
      env: { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0" },
      queue: async (h, number) => {
        await claimOrganicReview(h, number);
      },
    },
    {
      name: "held review",
      env: { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0" },
      queue: async (h, number) => {
        const tuple = await claimOrganicReview(h, number);
        const held = await post(h, "/complete", {
          ...tuple,
          outcome: "success",
          review_hold: "locked_conversation",
        });
        assert.equal(held.body.review_hold, "locked_conversation", JSON.stringify(held.body));
      },
    },
    {
      name: "different request",
      queue: async (h, number) => {
        await enqueue(h, "newer-request", {
          ...verifiedRequest(number, 6150293599),
          statusCommentId: 8000 + number,
          sourceCommentUpdatedAt: "2026-10-13T16:50:00Z",
        });
      },
    },
    {
      name: "answered request",
      env: { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "90000" },
      queue: async (h, number) => {
        // A newer request was answered; a later organic review waits pending.
        await enqueue(h, "newer-request", {
          ...verifiedRequest(number, 6150293599),
          statusCommentId: 8000 + number,
          sourceCommentUpdatedAt: "2026-10-13T16:50:00Z",
        });
        await reviewOnce(h, number);
        await enqueue(h, "organic-edit", organicEdit(number));
        assert.equal((await queueState(h)).items[`${repo}#${number}`]?.state, "pending");
      },
    },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    await t.test(scenario.name, async () => {
      const h = harness(scenario.env);
      await withExactReviewAdmissionHarness(h, async () => {
        const number = 97660 + index;
        const deferred = await deferredPublication(h, {
          ...verifiedRequest(number, 6150293501),
          statusCommentId: 7000 + number,
        });
        const publisher = await claimPublication(h, deferred.publicationKey);
        await scenario.queue(h, number);
        const before = structuredClone((await queueState(h)).items[deferred.key]);
        assert.ok(before);

        await enqueue(h, deferred.requeueDeliveryId, sourceDriftRequeue(deferred.claimed));
        assert.deepEqual((await queueState(h)).items[deferred.key], before);

        const completed = await post(h, "/complete", requeueCompletion(publisher));
        assert.deepEqual(completed, {
          status: 200,
          body: { ok: true, requeued: false, terminal_finalization: true },
        });
        const revision = publisher.lease_revision as number;
        assert.equal(
          lifecycleAt(h, number, deferred.publicationKey, revision)?.terminalDisposition?.kind,
          "superseded",
        );
        const state = await queueState(h);
        const driver = state.items[`terminal-finalization:${deferred.publicationKey}:${revision}`];
        assert.equal(driver?.terminalFinalization?.disposition, "superseded");
        assert.equal(driver?.decision.commandStatusMarker, deferred.claimed.commandStatusMarker);
        assert.equal(driver?.decision.statusCommentId, deferred.claimed.statusCommentId);
        // The queued review is still exactly what it was.
        const after = structuredClone(state.items[deferred.key]);
        assert.deepEqual(
          { decision: after?.decision, revision: after?.revision, state: after?.state },
          { decision: before.decision, revision: before.revision, state: before.state },
        );
      });
    });
  }
});

test("a deferred requeue keeps the handoff when the same request is already queued", async () => {
  const h = harness();
  await withExactReviewAdmissionHarness(h, async () => {
    const number = 97670;
    const request = { ...verifiedRequest(number, 6150293502), statusCommentId: 7670 };
    const deferred = await deferredPublication(h, request);
    const publisher = await claimPublication(h, deferred.publicationKey);
    // A redelivery of the same request queued its own review.
    await enqueue(h, "same-request-redelivery", request);
    const before = structuredClone((await queueState(h)).items[deferred.key]);

    await enqueue(h, deferred.requeueDeliveryId, sourceDriftRequeue(deferred.claimed));
    assert.deepEqual((await queueState(h)).items[deferred.key], before);
    const completed = await post(h, "/complete", requeueCompletion(publisher));
    assert.deepEqual(completed, { status: 200, body: { ok: true, requeued: false } });
    assert.equal(
      lifecycleAt(h, number, deferred.publicationKey, publisher.lease_revision as number)
        ?.terminalDisposition?.kind,
      "requeue",
    );
  });
});

test("the batch publisher's requeue post-effect answers a request no review carries", async () => {
  for (const carried of [true, false]) {
    const h = harness({
      EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
      EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: carried ? "90000" : "0",
    });
    await withExactReviewAdmissionHarness(h, async () => {
      const number = carried ? 97680 : 97681;
      const deferred = await deferredPublication(h, {
        ...verifiedRequest(number, 6150293503),
        statusCommentId: 7000 + number,
      });
      const claim = await post(h, "/publication-batches/claim", {
        claim_id: `claim-${number}`,
        lease_owner: "batch-worker",
        max_items: 1,
      });
      const member = claim.body.batch?.items?.[0];
      assert.equal(member?.item_key, deferred.publicationKey, JSON.stringify(claim.body));
      await enqueue(h, "organic-edit", organicEdit(number));
      if (!carried) await h.queue.alarm();
      assert.equal(
        (await queueState(h)).items[deferred.key]?.state,
        carried ? "pending" : "dispatching",
      );

      await enqueue(h, deferred.requeueDeliveryId, sourceDriftRequeue(deferred.claimed));
      assert.equal(
        (await queueState(h)).items[deferred.key]?.decision.commandStatusMarker,
        carried ? deferred.claimed.commandStatusMarker : undefined,
      );
      // exact-review-batch-publish.yml "Finalize healthy members" post-effect body.
      const postEffect = {
        canonical_target_key: `${repo}#${number}`,
        fence_key: member.item_key,
        revision: member.revision,
        kind: "requeue",
        // The batch CLI suffixes a hash of the fence key.
        operation_id: `terminal-batch:7200:1:${createHash("sha256")
          .update(member.item_key)
          .digest("hex")
          .slice(0, 24)}`,
      };
      const expected = carried ? "requeue" : "superseded";
      for (const attempt of [1, 2]) {
        const recorded = await post(h, "/lifecycle/terminal-disposition", postEffect);
        assert.equal(recorded.status, 200, `attempt ${attempt}: ${JSON.stringify(recorded.body)}`);
        assert.equal(recorded.body.lifecycle_state, expected, `attempt ${attempt}`);
      }
      const completed = await post(h, "/publication-batches/complete", {
        batch_id: claim.body.batch.batch_id,
        lease_owner: "batch-worker",
        items: [
          {
            item_key: member.item_key,
            revision: member.revision,
            claim_generation: member.claim_generation,
            terminal_outcome: "published",
          },
        ],
      });
      assert.equal(completed.status, 200, JSON.stringify(completed.body));
      assert.equal(
        lifecycleAt(h, number, member.item_key, member.revision)?.terminalDisposition?.kind,
        expected,
      );
      const finalizers = Object.values((await queueState(h)).items).filter(
        (item) => item.terminalFinalization,
      );
      assert.deepEqual(
        finalizers.map((item) => [
          item.terminalFinalization?.disposition,
          item.decision.commandStatusMarker,
        ]),
        carried ? [] : [["superseded", deferred.claimed.commandStatusMarker]],
      );
    });
  }
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
