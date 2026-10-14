import assert from "node:assert/strict";
import type { ExactReviewQueueState } from "../dashboard/exact-review-queue.ts";
import {
  createExactReviewAdmissionHarness,
  jsonResponse,
  withExactReviewAdmissionHarness,
} from "./dashboard-worker-harness.ts";

export const repo = "openclaw/openclaw";
export type Harness = ReturnType<typeof createExactReviewAdmissionHarness>;
let runCounter = 70_000;

export function harness(env: Record<string, string> = {}) {
  return createExactReviewAdmissionHarness(
    () => jsonResponse({ state: "open", updated_at: "2026-09-29T00:00:00Z" }),
    { env },
  );
}

export function decision(
  number: number,
  sourceAction: string,
  overrides: Record<string, unknown> = {},
) {
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

export function verifiedRequest(number: number, commentId: number) {
  return decision(number, "re_review", {
    commandStatusMarker: `<!-- clawsweeper-command-status:${number}:re_review:command-${commentId} -->`,
    sourceCommentId: commentId,
    sourceCommentUpdatedAt: "2026-10-13T16:32:00Z",
    commandBodyDigest: "a".repeat(64),
    commandOrigin: "hosted_webhook",
    sourceCommentVerified: true,
  });
}

export async function post(h: Harness, path: string, body: unknown) {
  const response = await h.queue.fetch(
    new Request(`https://queue${path}`, { method: "POST", body: JSON.stringify(body) }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

export async function enqueue(h: Harness, deliveryId: string, value: Record<string, unknown>) {
  const { status, body } = await post(h, "/enqueue", { delivery_id: deliveryId, decision: value });
  assert.equal(status, 202, JSON.stringify(body));
  return body;
}

export async function queueState(h: Harness) {
  return (await h.storage.get("exact-review-queue")) as ExactReviewQueueState;
}

/** Dispatch, claim, and successfully complete the item's current review generation. */
export async function reviewOnce(h: Harness, number: number) {
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
export function sourceDriftRequeue(claimed: Record<string, unknown>) {
  return { ...claimed, sourceAction: "source_drift_requeue", supersedesInProgress: true };
}

/** A review generation that hands its verdict to a deferred publication. */
export async function deferredPublication(h: Harness, request: Record<string, unknown>) {
  const number = Number(request.itemNumber);
  const key = `${repo}#${number}`;
  await enqueue(h, `request-${number}-${runCounter++}`, request);
  await h.queue.alarm();
  const review = (await queueState(h)).items[key]!;
  const producerRunId = String(runCounter++);
  const tuple = {
    item_key: key,
    lease_id: review.leaseId,
    lease_revision: review.leaseRevision,
    run_id: producerRunId,
    run_attempt: 1,
  };
  const claim = await post(h, "/claim", tuple);
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const claimed = claim.body.decision as Record<string, unknown>;
  const publicationDecision = {
    ...claimed,
    sourceAction: "exact_review_artifact_publish",
    supersedesInProgress: false,
    publication: {
      artifactName: `exact-review-${producerRunId}-1`,
      producerRunId,
      producerRunAttempt: 1,
      sourceSha: "a".repeat(40),
      itemKey: key,
      protocolVersion: 2,
      leaseRevision: review.leaseRevision,
      claimGeneration: claim.body.claim_generation,
      liveProceeded: true,
      liveTerminalNoop: false,
      liveTerminalMissing: false,
      liveGuardedOpen: false,
      producerDecision: claimed,
    },
  };
  await enqueue(h, `publisher:${producerRunId}:1`, publicationDecision);
  const complete = await post(h, "/complete", {
    ...tuple,
    claim_generation: claim.body.claim_generation,
    outcome: "success",
  });
  assert.equal(complete.status, 200, JSON.stringify(complete.body));
  return {
    claimed,
    key,
    producerRunId,
    publicationDecision,
    publicationKey: `${key}@publish:${producerRunId}:1`,
    // sweep.yml "Queue fresh review after source drift" and the batch publisher.
    requeueDeliveryId: `publisher-source-drift:${producerRunId}:1`,
  };
}

/** A publisher run claims the deferred publication and holds its lease. */
export async function claimPublication(h: Harness, publicationKey: string) {
  await h.queue.alarm();
  const publication = (await queueState(h)).items[publicationKey];
  assert.ok(publication?.leaseId, "the deferred publication was dispatched");
  const publisher = {
    item_key: publicationKey,
    lease_id: publication.leaseId,
    lease_revision: publication.leaseRevision,
    run_id: String(runCounter++),
    run_attempt: 1,
  };
  const claim = await post(h, "/claim", publisher);
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  return { ...publisher, claim_generation: claim.body.claim_generation };
}

/**
 * What happens between the publisher's claim and its source-drift requeue. A
 * scenario may return a step that runs after the requeue. Only "open" leaves
 * the request unanswered and its own publication held.
 */
export const DEFERRED_CONTINUATION_SCENARIOS = {
  open: async () => {},
  "publication-finished": async (h: Harness, _number: number, publisher: object) => {
    const published = await post(h, "/complete", {
      ...publisher,
      outcome: "success",
      completion_kind: "published",
      reason_code: "publication_applied",
    });
    assert.equal(published.status, 200, JSON.stringify(published.body));
  },
  "lease-lost": async () => {
    const later = Date.now() + 6 * 60 * 60_000;
    Date.now = () => later;
  },
  "newer-command-answered": async (h: Harness, number: number) => {
    // The newer request reuses the status comment under its own marker.
    await enqueue(h, "newer-request", {
      ...verifiedRequest(number, 6150293399),
      statusCommentId: 7000 + number,
      sourceCommentUpdatedAt: "2026-10-13T16:50:00Z",
    });
    await reviewOnce(h, number);
  },
  "newer-command-answered-under-other-casing": async (h: Harness, number: number) => {
    // The same item reached under another repository casing is the same item.
    const casedKey = `OpenClaw/OpenClaw#${number}`;
    await enqueue(h, "newer-request-other-casing", {
      ...verifiedRequest(number, 6150293398),
      targetRepo: "OpenClaw/OpenClaw",
      statusCommentId: 7000 + number,
      sourceCommentUpdatedAt: "2026-10-13T16:50:00Z",
    });
    await h.queue.alarm();
    const review = (await queueState(h)).items[casedKey];
    assert.ok(review?.leaseId, "the newer request under another casing was dispatched");
    const tuple = {
      item_key: casedKey,
      lease_id: review.leaseId,
      lease_revision: review.leaseRevision,
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
  },
  "newer-publication": async (h: Harness, number: number) => {
    // A later review generation's publication waits behind the held one.
    const newer = await deferredPublication(h, decision(number, "edited"));
    assert.ok((await queueState(h)).items[newer.publicationKey]);
  },
  "older-producer-borrows-newer-publication": async (
    h: Harness,
    number: number,
    publisher: object,
  ) => {
    // A second generation of the same request defers its own publication; the
    // older one ends superseded, so only the newer publication is held when the
    // older producer's requeue arrives.
    const newer = await deferredPublication(h, {
      ...verifiedRequest(number, 6150293300),
      statusCommentId: 7000 + number,
    });
    const superseded = await post(h, "/complete", {
      ...publisher,
      outcome: "success",
      completion_kind: "superseded",
      reason_code: "remote_newer_tuple",
    });
    assert.equal(superseded.status, 200, JSON.stringify(superseded.body));
    const newerPublisher = await claimPublication(h, newer.publicationKey);
    // The newer publication then answers the request before the continuation runs.
    return async () => {
      const published = await post(h, "/complete", {
        ...newerPublisher,
        outcome: "success",
        completion_kind: "published",
        reason_code: "publication_applied",
      });
      assert.equal(published.status, 200, JSON.stringify(published.body));
    };
  },
} satisfies Record<
  string,
  (h: Harness, number: number, publisher: object) => Promise<void | (() => Promise<void>)>
>;
export type DeferredContinuationScenario = keyof typeof DEFERRED_CONTINUATION_SCENARIOS;

/**
 * Runs a verified request through a deferred publication and the publisher's
 * source-drift requeue on the real queue, then returns the requeued item's
 * stored state and the decision its review job claims (CLAIM_DECISION, which the
 * publisher later passes on as EXACT_REVIEW_DECISION).
 */
export async function deferredContinuationClaim(
  scenario: DeferredContinuationScenario,
  number: number,
) {
  const realNow = Date.now;
  const h = harness({ EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0" });
  try {
    return await withExactReviewAdmissionHarness(h, async () => {
      const deferred = await deferredPublication(h, {
        ...verifiedRequest(number, 6150293300),
        statusCommentId: 7000 + number,
      });
      const publisher = await claimPublication(h, deferred.publicationKey);
      const afterRequeue = await DEFERRED_CONTINUATION_SCENARIOS[scenario](h, number, publisher);
      await enqueue(h, deferred.requeueDeliveryId, sourceDriftRequeue(deferred.claimed));
      const stored = (await queueState(h)).items[deferred.key];
      assert.ok(stored, `${scenario}: the requeue admitted a review`);
      if (afterRequeue) await afterRequeue();
      return {
        requested: deferred.claimed,
        stored,
        requeueDeliveryId: deferred.requeueDeliveryId,
        claimed: await reviewOnce(h, number),
      };
    });
  } finally {
    Date.now = realNow;
  }
}
