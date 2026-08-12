import assert from "node:assert/strict";
import test from "node:test";
import {
  exactReviewPrioritizePublicationItems,
  exactReviewQueueActivePublicationCount,
  exactReviewQueueActiveReviewCount,
  exactReviewQueueAdmittedItems,
  exactReviewQueueBayProjection,
  exactReviewQueueLaneStats,
  exactReviewQueueNextWakeAt,
  exactReviewQueueStats,
  type ExactReviewBayBatchOwner,
} from "../dashboard/exact-review-read-model.ts";
import type {
  ExactReviewQueueItem,
  ExactReviewQueueState,
} from "../dashboard/exact-review-queue.ts";
import {
  oldExactReviewPrioritizePublicationItems,
  oldExactReviewQueueActivePublicationCount,
  oldExactReviewQueueActiveReviewCount,
  oldExactReviewQueueAdmittedItems,
  oldExactReviewQueueBayProjection,
  oldExactReviewQueueLaneStats,
  oldExactReviewQueueNextWakeAt,
  oldExactReviewQueueStats,
} from "./fixtures/exact-review-read-model-old.ts";

const NOW = Date.parse("2026-08-11T18:00:00.000Z");
const SEEDS = [0x1, 0x2a, 0x1234abcd, 0x5eedc0de, 0x7fffffff, 0xdeadbeef];

test("single-census read model is property-equivalent to the extracted implementation", () => {
  for (const seed of SEEDS) {
    const random = seededRandom(seed);
    for (let population = 0; population < 12; population += 1) {
      const state = randomQueueState(random, population === 0 ? 0 : 1 + random.int(120));
      const items = Object.values(state.items);
      const excluded = new Set(items.filter((_, index) => index % 7 === 0).map((item) => item.key));
      const fresh = new Set(items.filter((_, index) => index % 5 === 0).map((item) => item.key));
      const batchByItemKey = new Map<string, ExactReviewBayBatchOwner>(
        items
          .filter((_, index) => index % 11 === 0)
          .map((item, index) => [item.key, { batchId: `batch-${seed}-${index}` }]),
      );
      const priorityKeys = items
        .filter((_, index) => index % 9 === 0)
        .map((item) => `${item.decision.targetRepo}#${item.decision.itemNumber}`);
      const capacity = random.int(9);
      const targetCapacity = random.int(4);
      const publicationCapacity = random.int(7);
      const publicationBlockedUntil = random.bool() ? NOW + random.int(90_000) : null;
      const reviewAdmissionBlockedUntil = random.bool() ? NOW + random.int(45_000) : null;

      const oldStats = oldExactReviewQueueStats(
        state,
        NOW,
        capacity,
        targetCapacity,
        publicationCapacity,
        6 * 60_000,
        130 * 60_000,
        15 * 60_000,
        20 * 60_000,
        excluded,
        publicationBlockedUntil,
      );
      const newStats = exactReviewQueueStats(
        state,
        NOW,
        capacity,
        targetCapacity,
        publicationCapacity,
        6 * 60_000,
        130 * 60_000,
        15 * 60_000,
        20 * 60_000,
        excluded,
        publicationBlockedUntil,
      );
      assert.deepEqual(newStats, oldStats, `stats seed=${seed} population=${population}`);
      assert.equal(
        JSON.stringify(newStats),
        JSON.stringify(oldStats),
        `stats bytes seed=${seed} population=${population}`,
      );
      assert.deepEqual(
        exactReviewQueueBayProjection(items, priorityKeys, batchByItemKey),
        oldExactReviewQueueBayProjection(items, priorityKeys, batchByItemKey),
        `Bay seed=${seed} population=${population}`,
      );
      assert.deepEqual(
        exactReviewQueueLaneStats(items, NOW, capacity, state.shedSinceReset, state),
        oldExactReviewQueueLaneStats(items, NOW, capacity, state.shedSinceReset, state),
        `lane seed=${seed} population=${population}`,
      );
      const publicationAdmissionBlocked = random.bool();
      const uniquePublicationItems = random.bool();
      const freshPublicationReserve = random.int(4);
      assert.deepEqual(
        exactReviewQueueAdmittedItems(
          state,
          NOW,
          capacity,
          targetCapacity,
          publicationCapacity,
          excluded,
          publicationAdmissionBlocked,
          uniquePublicationItems,
          fresh,
          freshPublicationReserve,
        ).map((item) => item.key),
        oldExactReviewQueueAdmittedItems(
          state,
          NOW,
          capacity,
          targetCapacity,
          publicationCapacity,
          excluded,
          publicationAdmissionBlocked,
          uniquePublicationItems,
          fresh,
          freshPublicationReserve,
        ).map((item) => item.key),
        `admission seed=${seed} population=${population}`,
      );
      assert.equal(
        exactReviewQueueNextWakeAt(
          state,
          NOW,
          capacity,
          targetCapacity,
          publicationCapacity,
          15 * 60_000,
          20 * 60_000,
          excluded,
          publicationBlockedUntil,
          reviewAdmissionBlockedUntil,
        ),
        oldExactReviewQueueNextWakeAt(
          state,
          NOW,
          capacity,
          targetCapacity,
          publicationCapacity,
          15 * 60_000,
          20 * 60_000,
          excluded,
          publicationBlockedUntil,
          reviewAdmissionBlockedUntil,
        ),
        `wake seed=${seed} population=${population}`,
      );
      assert.equal(
        exactReviewQueueActiveReviewCount(state),
        oldExactReviewQueueActiveReviewCount(state),
      );
      assert.equal(
        exactReviewQueueActivePublicationCount(state),
        oldExactReviewQueueActivePublicationCount(state),
      );
      const publications = items.filter((item) => item.decision.publication);
      const reserve = random.int(5);
      assert.deepEqual(
        exactReviewPrioritizePublicationItems(publications, fresh, reserve).map((item) => item.key),
        oldExactReviewPrioritizePublicationItems(publications, fresh, reserve).map(
          (item) => item.key,
        ),
      );
    }
  }
});

function randomQueueState(random: SeededRandom, size: number): ExactReviewQueueState {
  const states = ["pending", "dispatching", "leased", "parked"] as const;
  const targets = ["openclaw/openclaw", "openclaw/clawhub", "openclaw/clawsweeper"];
  const items: Record<string, ExactReviewQueueItem> = {};
  for (let index = 0; index < size; index += 1) {
    const state = states[random.int(states.length)];
    const publication = random.int(4) === 0;
    const targetRepo = targets[random.int(targets.length)];
    const itemNumber = 10_000 + random.int(Math.max(1, Math.floor(size / 3) + 1));
    const createdAt = NOW - random.int(8 * 60 * 60_000);
    const updatedAt = createdAt + random.int(Math.max(1, NOW - createdAt + 1));
    const nextAttemptAt = NOW - 60_000 + random.int(4 * 60_000);
    const key = `${targetRepo}#${itemNumber}${publication ? `@publish:${index}` : `@review:${index}`}`;
    const sourceAction = publication
      ? "exact_review_artifact_publish"
      : random.int(5) === 0
        ? "source_drift_requeue"
        : "opened";
    const decision = {
      targetRepo,
      targetBranch: "main",
      itemNumber,
      itemKind: random.bool() ? "issue" : "pull_request",
      sourceEvent: random.bool() ? "issues" : "pull_request",
      sourceAction,
      supersedesInProgress: false,
      ...(publication
        ? {
            publication: {
              artifactName: `artifact-${index}`,
              producerRunId: String(1000 + index),
              producerRunAttempt: 1,
              sourceSha: `${index}`.padStart(40, "a"),
              itemKey: `${targetRepo}#${itemNumber}`,
              protocolVersion: 2 as const,
              leaseRevision: index,
              claimGeneration: index,
              liveProceeded: true,
              liveTerminalNoop: false,
              liveTerminalMissing: false,
              liveGuardedOpen: false,
              producerDecision: {
                targetRepo,
                targetBranch: "main",
                itemNumber,
                itemKind: "issue" as const,
                sourceEvent: "issues" as const,
                sourceAction: "opened",
                supersedesInProgress: false,
              },
            },
          }
        : {}),
    } as ExactReviewQueueItem["decision"];
    const leaseExpiresAt = NOW + 1_000 + random.int(3 * 60 * 60_000);
    items[key] = {
      key,
      decision,
      state,
      revision: 1 + random.int(5),
      createdAt,
      updatedAt,
      nextAttemptAt,
      attempts: random.int(4),
      ...(state === "dispatching" || state === "leased"
        ? {
            leaseExpiresAt: random.int(12) === 0 ? undefined : leaseExpiresAt,
            dispatchedAt: state === "dispatching" ? NOW - random.int(10 * 60_000) : undefined,
            claimedAt: state === "leased" ? NOW - random.int(90 * 60_000) : undefined,
            leaseHeartbeatAt: state === "leased" ? NOW - random.int(25 * 60_000) : undefined,
            leasePhase: random.int(6) === 0 ? ("finalizing" as const) : ("review" as const),
          }
        : {}),
      ...(state === "parked"
        ? {
            parkedReason: random.bool() ? "dispatch_rejected" : "review_retry_exhausted",
            parkedRecoveryAttempts: random.int(5),
            parkedRecoveryAt: random.bool() ? NOW + random.int(30 * 60_000) : undefined,
            parkedTerminalCheckedAt: NOW - random.int(20 * 60_000),
          }
        : {}),
      ...(state === "pending" && nextAttemptAt > NOW && random.bool()
        ? {
            backoffReason: publication
              ? ("publication_retry" as const)
              : ("retry_backoff" as const),
          }
        : {}),
      ...(publication && random.bool() ? { publicationFailureAttempts: 1 + random.int(3) } : {}),
      ...(!publication && random.bool() ? { reviewFailureAttempts: random.int(3) } : {}),
    };
  }
  const dispatcherState = ["active", "paused", "blocked", "unknown"] as const;
  const selectedDispatcherState = dispatcherState[random.int(dispatcherState.length)];
  return {
    items,
    shedSinceReset: random.int(20),
    dispatcher: {
      state: selectedDispatcherState,
      checkedAt: NOW - random.int(60_000),
      retryAt:
        selectedDispatcherState === "paused" || selectedDispatcherState === "blocked"
          ? NOW - 30_000 + random.int(120_000)
          : undefined,
      reviewAdmissionNextAt: random.bool() ? NOW + random.int(90_000) : undefined,
      parkedTerminalCheckedAt: NOW - random.int(15 * 60_000),
      githubCredentialCircuits: {
        openclaw: {
          poolKey: "target_app:openclaw",
          scope: "target_app",
          targetOwner: "openclaw",
          observedAt: NOW - 1_000,
          retryAt: NOW - 30_000 + random.int(120_000),
          provenance: "fallback",
          authoritative: false,
        },
      },
    },
  };
}

type SeededRandom = ReturnType<typeof seededRandom>;

function seededRandom(seed: number) {
  let value = seed >>> 0;
  const next = () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return value >>> 0;
  };
  return {
    int(limit: number) {
      return next() % limit;
    },
    bool() {
      return (next() & 1) === 1;
    },
  };
}
