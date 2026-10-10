import assert from "node:assert/strict";
import test from "node:test";
import type { ExactReviewQueueState } from "../dashboard/exact-review-queue.ts";
import {
  exactReviewParkedOperatorEligible,
  exactReviewQueueBayProjection,
} from "../dashboard/exact-review-read-model.ts";
import { publicExactReviewQueueProjection } from "../dashboard/worker.ts";
import {
  createExactReviewAdmissionHarness,
  jsonResponse,
  withExactReviewAdmissionHarness,
} from "./dashboard-worker-harness.ts";

const repo = "openclaw/openclaw";
const headA = "a".repeat(40);
const headB = "b".repeat(40);
type Harness = ReturnType<typeof createExactReviewAdmissionHarness>;
let runCounter = 80_000;

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

function pullDecision(
  number: number,
  sourceAction: string,
  overrides: Record<string, unknown> = {},
) {
  return decision(number, sourceAction, {
    itemKind: "pull_request",
    sourceEvent: "pull_request",
    ...overrides,
  });
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

/** Dispatch and claim the item's current generation; returns its completion tuple. */
async function claimOnce(h: Harness, number: number) {
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
  return { ...tuple, claim_generation: claim.body.claim_generation as number };
}

/** The completion sweep.yml sends after the live check took the given no-op path. */
async function completeHeld(h: Harness, number: number, reviewHold: string) {
  const tuple = await claimOnce(h, number);
  return post(h, "/complete", { ...tuple, outcome: "success", review_hold: reviewHold });
}

function lockedIssueHarness(live: { locked: boolean; updatedAt: string }) {
  return createExactReviewAdmissionHarness(() =>
    jsonResponse({ state: "open", locked: live.locked, updated_at: live.updatedAt }),
  );
}

function pullHarness(live: { head: string }) {
  return createExactReviewAdmissionHarness(() =>
    jsonResponse({
      state: "open",
      title: "Oversized PR",
      body: "",
      locked: false,
      labels: [],
      draft: true,
      head: { sha: live.head },
      base: { sha: "c".repeat(40) },
      updated_at: "2026-10-04T22:10:32Z",
    }),
  );
}

test("a locked issue's guarded no-op holds until an organic unlock", async () => {
  const live = { locked: true, updatedAt: "2026-09-09T02:17:31Z" };
  const h = lockedIssueHarness(live);
  await withExactReviewAdmissionHarness(h, async () => {
    const number = 56312;
    const key = `${repo}#${number}`;
    const offer = (lane: string, delivery: string) =>
      enqueue(h, delivery, decision(number, lane, { sourceUpdatedAt: live.updatedAt }));

    assert.equal((await offer("scheduled_normal_backfill", "normal-1")).queued, true);
    const completed = await completeHeld(h, number, "locked_conversation");
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    assert.equal(completed.body.review_hold, "locked_conversation");
    const held = (await queueState(h)).items[key]!;
    assert.equal(held.state, "parked");
    assert.equal(held.parkedReason, "locked_conversation");
    assert.equal(held.leaseId, undefined);
    assert.equal(exactReviewParkedOperatorEligible(held), true);
    assert.equal(h.dispatched.length, 1);

    // Every later scheduled offer and automatic recovery dedupes: no claim.
    for (const [index, lane] of [
      "scheduled_normal_backfill",
      "scheduled_hot_intake",
      "scheduled_normal_backfill",
    ].entries()) {
      const repeat = await offer(lane, `repeat-${index}`);
      assert.deepEqual(
        { deduped: repeat.deduped, scope: repeat.dedupe_scope, reason: repeat.dedupe_reason },
        { deduped: true, scope: "scheduled_queue_item", reason: "locked_conversation" },
      );
      await h.queue.alarm();
    }
    const recovery = await enqueue(
      h,
      "shard-recovery",
      decision(number, "failed_review_shard_recovery"),
    );
    assert.deepEqual(
      { scope: recovery.dedupe_scope, reason: recovery.dedupe_reason },
      { scope: "review_hold", reason: "locked_conversation" },
    );
    await h.queue.alarm();
    assert.equal(h.dispatched.length, 1, "held item spends no further review runs");
    assert.equal((await queueState(h)).items[key]!.revision, held.revision);

    const snapshot = await stats(h);
    assert.equal(snapshot.lanes.review.parked, 1);
    assert.equal(snapshot.lanes.review.parked_reasons.locked_conversation, 1);
    const projected = publicExactReviewQueueProjection(snapshot, new Set([repo]));
    assert.equal(projected.collection.state, "complete");
    assert.equal(projected.lanes.review.parked_reasons.locked_conversation, 1);
    assert.equal(projected.lanes.review.parked_reasons.unknown, 0);
    // Bay keeps the completed lifecycle card instead of showing active work.
    const bay = exactReviewQueueBayProjection(Object.values((await queueState(h)).items));
    assert.equal(bay.complete, true);
    assert.equal(bay.total, 0);
    assert.equal(bay.stages?.repairing, 0);

    live.locked = false;
    live.updatedAt = "2026-10-05T00:00:00Z";
    const unlocked = await enqueue(
      h,
      "organic-unlocked",
      decision(number, "unlocked", { sourceUpdatedAt: live.updatedAt }),
    );
    assert.equal(unlocked.queued, true);
    const released = (await queueState(h)).items[key]!;
    assert.equal(released.state, "pending");
    assert.equal(released.parkedReason, undefined);
    assert.equal(released.decision.sourceAction, "unlocked");
    await h.queue.alarm();
    assert.equal(h.dispatched.length, 2, "the unlocked issue is reviewed again");
  });
});

test("an oversized PR holds on its head until a push or reconciliation releases it", async () => {
  const live = { head: headA };
  const h = pullHarness(live);
  await withExactReviewAdmissionHarness(h, async () => {
    const number = 119055;
    const key = `${repo}#${number}`;
    const offer = (lane: string, delivery: string) =>
      enqueue(h, delivery, pullDecision(number, lane, { sourceUpdatedAt: "2026-10-04T22:10:32Z" }));

    assert.equal((await offer("scheduled_hot_intake", "hot-1")).queued, true);
    const completed = await completeHeld(h, number, "oversized_pull_request");
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    const held = (await queueState(h)).items[key]!;
    assert.equal(held.parkedReason, "oversized_pull_request");
    assert.equal(held.decision.sourceHeadSha, headA, "the hold pins the scheduled-bound head");

    // ClawSweeper's own lease-comment writes move updated_at; scheduled
    // offers carrying that newer timestamp still dedupe.
    for (const [index, lane] of ["scheduled_normal_backfill", "scheduled_hot_intake"].entries()) {
      const repeat = await enqueue(
        h,
        `repeat-${index}`,
        pullDecision(number, lane, { sourceUpdatedAt: `2026-10-04T22:2${index}:00Z` }),
      );
      assert.equal(repeat.dedupe_reason, "oversized_pull_request");
    }
    await h.queue.alarm();
    assert.equal(h.dispatched.length, 1);

    // Unchanged source identity is not recoverable by the parked reconciler.
    const listed = await post(h, "/parked-reviews/list", { limit: 10 });
    const row = listed.body.parked_reviews.find(
      (entry: { item_key: string }) => entry.item_key === key,
    );
    assert.equal(row.parked_reason, "oversized_pull_request");
    const unchanged = await post(h, "/parked-reviews/recover-fresh", {
      idempotency_key: "unchanged",
      items: [row],
    });
    assert.equal(unchanged.body.unchanged, 1);

    // A pushed head makes the parked terminal check drop the stale hold.
    live.head = headB;
    const state = await queueState(h);
    state.items[key]!.parkedTerminalCheckedAt = 0;
    await h.storage.put("exact-review-queue", state);
    await h.queue.alarm();
    assert.equal((await queueState(h)).items[key], undefined);
    assert.equal((await offer("scheduled_hot_intake", "hot-after-push")).queued, true);
  });
});

test("an organic synchronize releases an oversized hold immediately", async () => {
  const live = { head: headA };
  const h = pullHarness(live);
  await withExactReviewAdmissionHarness(h, async () => {
    const number = 119056;
    const key = `${repo}#${number}`;
    await enqueue(h, "hot-1", pullDecision(number, "scheduled_hot_intake"));
    await completeHeld(h, number, "oversized_pull_request");
    assert.equal((await queueState(h)).items[key]!.parkedReason, "oversized_pull_request");
    live.head = headB;
    const synchronize = await enqueue(
      h,
      "synchronize",
      pullDecision(number, "synchronize", {
        supersedesInProgress: true,
        sourceHeadSha: headB,
        sourceHeadVerified: true,
        sourceAuthoritySeq: 2,
        sourceUpdatedAt: "2026-10-05T00:00:00Z",
      }),
    );
    assert.equal(synchronize.queued, true);
    const released = (await queueState(h)).items[key]!;
    assert.equal(released.state, "pending");
    assert.equal(released.decision.sourceHeadSha, headB);
  });
});

test("holds never retain command work, unpinned PRs, or input that arrived during the lease", async () => {
  const live = { locked: true, updatedAt: "2026-09-09T02:17:31Z" };
  const h = lockedIssueHarness(live);
  await withExactReviewAdmissionHarness(h, async () => {
    const command = 40088;
    await enqueue(
      h,
      "command",
      decision(command, "re_review", {
        commandStatusMarker: `<!-- clawsweeper-command-status:${command}:re_review:token -->`,
      }),
    );
    const commandCompletion = await completeHeld(h, command, "locked_conversation");
    assert.equal(commandCompletion.status, 200, JSON.stringify(commandCompletion.body));
    assert.equal(commandCompletion.body.review_hold, undefined);
    assert.notEqual(
      (await queueState(h)).items[`${repo}#${command}`]?.parkedReason,
      "locked_conversation",
      "command context keeps its own lifecycle",
    );

    const unpinned = 38283;
    await enqueue(h, "unpinned", pullDecision(unpinned, "opened"));
    const unpinnedCompletion = await completeHeld(h, unpinned, "oversized_pull_request");
    assert.equal(unpinnedCompletion.status, 200, JSON.stringify(unpinnedCompletion.body));
    assert.equal((await queueState(h)).items[`${repo}#${unpinned}`], undefined);

    const raced = 84599;
    await enqueue(h, "raced", decision(raced, "scheduled_normal_backfill"));
    const tuple = await claimOnce(h, raced);
    await enqueue(h, "raced-edit", decision(raced, "edited", { supersedesInProgress: false }));
    const completed = await post(h, "/complete", {
      ...tuple,
      outcome: "success",
      review_hold: "locked_conversation",
    });
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    assert.notEqual(
      (await queueState(h)).items[`${repo}#${raced}`]?.parkedReason,
      "locked_conversation",
      "an edit during the lease is a real change",
    );
  });
});

test("completion rejects malformed or non-terminal holds", async () => {
  const h = lockedIssueHarness({ locked: true, updatedAt: "2026-09-09T02:17:31Z" });
  await withExactReviewAdmissionHarness(h, async () => {
    const number = 101716;
    await enqueue(h, "normal", decision(number, "scheduled_normal_backfill"));
    const tuple = await claimOnce(h, number);
    for (const [body, error] of [
      [{ outcome: "success", review_hold: "closed" }, "invalid_review_hold"],
      [
        { outcome: "failure", review_hold: "locked_conversation" },
        "review_hold_without_terminal_success",
      ],
      [
        { outcome: "success", requeue_latest: true, review_hold: "locked_conversation" },
        "review_hold_without_terminal_success",
      ],
    ] as const) {
      const rejected = await post(h, "/complete", { ...tuple, ...body });
      assert.equal(rejected.status, 400);
      assert.equal(rejected.body.error, error);
    }
    const accepted = await post(h, "/complete", {
      ...tuple,
      outcome: "success",
      review_hold: "locked_conversation",
    });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  });
});
