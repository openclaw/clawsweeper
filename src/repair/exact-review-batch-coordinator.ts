import { createHash } from "node:crypto";

import {
  publishExactReviewBatch,
  type ExactReviewBatchItemResult,
  type ExactReviewBatchPublisherResult,
} from "./exact-review-batch-publisher.js";
import type {
  ExactReviewBatchQueue,
  ExactReviewBatchQueueItem,
} from "./exact-review-batch-queue-client.js";
import type { PreparedStateMutationPlan } from "./state-publication-mutation.js";

export type ExactReviewBatchCoordinatorDependencies = {
  queue: ExactReviewBatchQueue;
  prepare: (item: ExactReviewBatchQueueItem) => Promise<ExactReviewBatchItemResult>;
  deliverGithubEffects: (item: ExactReviewBatchQueueItem) => Promise<"ready" | "superseded">;
  commit: (
    batchId: string,
    plans: readonly PreparedStateMutationPlan[],
  ) => Promise<{ commitSha: string }>;
};

export type ExactReviewBatchCoordinatorResult =
  | { kind: "idle" }
  | {
      kind: "claimed";
      batchId: string;
      accepted: number;
      skipped: number;
      publication: ExactReviewBatchPublisherResult;
    };

export async function coordinateExactReviewBatch(
  options: {
    claimId: string;
    leaseOwner: string;
    maxItems: number;
    heartbeatIntervalMs?: number;
  },
  dependencies: ExactReviewBatchCoordinatorDependencies,
): Promise<ExactReviewBatchCoordinatorResult> {
  const lease = await dependencies.queue.claim(options);
  if (!lease) return { kind: "idle" };
  const fetched = await dependencies.queue.fetch({
    batchId: lease.batchId,
    leaseOwner: options.leaseOwner,
  });
  if (!fetched.items.length) {
    return {
      kind: "claimed",
      batchId: lease.batchId,
      accepted: 0,
      skipped: 0,
      publication: { completions: [], retryable: [], stateCommitSha: null },
    };
  }

  const itemsByKey = new Map(fetched.items.map((item) => [item.itemKey, item]));
  return withLeaseHeartbeat(
    {
      queue: dependencies.queue,
      batchId: lease.batchId,
      leaseOwner: options.leaseOwner,
      items: fetched.items,
      intervalMs: options.heartbeatIntervalMs ?? 60_000,
    },
    async (assertLease) => {
      const publication = await publishExactReviewBatch(fetched.items, {
        assertLease,
        prepare: (member) => dependencies.prepare(requiredItem(itemsByKey, member.itemKey)),
        deliverGithubEffects: (member) =>
          dependencies.deliverGithubEffects(requiredItem(itemsByKey, member.itemKey)),
        commit: (plans) => dependencies.commit(lease.batchId, plans),
      });
      await assertLease();
      if (!publication.completions.length) {
        return {
          kind: "claimed" as const,
          batchId: lease.batchId,
          accepted: 0,
          skipped: 0,
          publication,
        };
      }
      const completion = await dependencies.queue.complete({
        batchId: lease.batchId,
        leaseOwner: options.leaseOwner,
        items: publication.completions,
        ...(publication.stateCommitSha ? { stateCommitSha: publication.stateCommitSha } : {}),
        ...(publication.retryable.length
          ? { failureFingerprint: retryableFingerprint(publication.retryable) }
          : {}),
      });
      return {
        kind: "claimed" as const,
        batchId: lease.batchId,
        accepted: completion.accepted,
        skipped: completion.skipped,
        publication,
      };
    },
  );
}

async function withLeaseHeartbeat<T>(
  options: {
    queue: ExactReviewBatchQueue;
    batchId: string;
    leaseOwner: string;
    items: readonly ExactReviewBatchQueueItem[];
    intervalMs: number;
  },
  operation: (assertLease: () => Promise<void>) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1) {
    throw new Error("Batch heartbeat interval must be a positive integer");
  }
  let heartbeatFailure: unknown;
  const heartbeatState: { inFlight: Promise<void> | null } = { inFlight: null };
  const heartbeat = async () => {
    if (heartbeatFailure) throw heartbeatFailure;
    if (!heartbeatState.inFlight) {
      heartbeatState.inFlight = options.queue
        .heartbeat({
          batchId: options.batchId,
          leaseOwner: options.leaseOwner,
          items: options.items,
        })
        .then(() => undefined)
        .catch((error) => {
          heartbeatFailure = error;
          throw error;
        })
        .finally(() => {
          heartbeatState.inFlight = null;
        });
    }
    await heartbeatState.inFlight;
    if (heartbeatFailure) throw heartbeatFailure;
  };
  const timer = setInterval(() => {
    void heartbeat().catch(() => undefined);
  }, options.intervalMs);
  timer.unref();
  try {
    await heartbeat();
    const result = await operation(heartbeat);
    await heartbeat();
    return result;
  } finally {
    clearInterval(timer);
    const pendingHeartbeat = heartbeatState.inFlight;
    if (pendingHeartbeat) await pendingHeartbeat.catch(() => undefined);
  }
}

function requiredItem(
  items: ReadonlyMap<string, ExactReviewBatchQueueItem>,
  itemKey: string,
): ExactReviewBatchQueueItem {
  const item = items.get(itemKey);
  if (!item) throw new Error(`Batch item ${itemKey} disappeared after fetch`);
  return item;
}

function retryableFingerprint(
  failures: ReadonlyArray<{ itemKey: string; revision: number; reason: string }>,
): string {
  const canonical = [...failures]
    .sort((left, right) => left.itemKey.localeCompare(right.itemKey))
    .map(({ itemKey, revision, reason }) => ({ itemKey, revision, reason }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
