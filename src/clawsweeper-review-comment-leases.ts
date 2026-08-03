import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  AcquiredReviewStartLease,
  ExactReviewQueueAuthority,
  Item,
  ReviewStartStatusCommentOptions,
  ReviewStartStatusCommentResult,
} from "./clawsweeper-types.js";
import { UserFacingCommandError } from "./command.js";
import {
  expiredReviewStartStatusLeases,
  freshExactHeadReviewStartLease,
  supersededReviewStartStatusLeases,
} from "./repair/comment-router-core.js";
import type { ReviewCommentWorkflowDependencies } from "./clawsweeper-review-comment-dependencies.js";
import type { createReviewCommentIdentity } from "./clawsweeper-review-comment-identity.js";
import type { createReviewCommentState } from "./clawsweeper-review-comment-state.js";
import type { createReviewCommentPublication } from "./clawsweeper-review-comment-publication.js";

export function createReviewCommentLeases(
  dependencies: ReviewCommentWorkflowDependencies &
    ReturnType<typeof createReviewCommentIdentity> &
    ReturnType<typeof createReviewCommentState> &
    ReturnType<typeof createReviewCommentPublication>,
) {
  const {
    targetRepo,
    heldReviewStartStatusCommentResult,
    gitHubRuntimeBudgetError: GitHubRuntimeBudgetError,
    ghObservedMutationCommand,
    currentReviewRevision,
    pullRequestHeadSha,
    reviewCommentMarker,
    renderReviewStartStatusComment,
    issueReviewCommentState,
    commentId,
    commentBody,
    PATCHABLE_REVIEW_COMMENT_AUTHORS,
    canPatchReviewComment,
    writeCommentPayload,
    reviewCommentFromMutationResponse,
  } = dependencies;

  function reviewStartLeaseOwner(comment: Record<string, unknown> | undefined): string | null {
    const body = commentBody(comment) ?? "";
    const match = body.match(/<!--\s*clawsweeper-review-status:started\b([^>]*)-->/i);
    return match?.[1]?.match(/\bowner=([^\s>]+)/i)?.[1] ?? null;
  }

  function newReviewStartLeaseOwner(
    env: NodeJS.ProcessEnv = process.env,
    fallback: () => string = randomUUID,
  ): string {
    const runId = String(env.GITHUB_RUN_ID ?? "").trim();
    const runAttempt = String(env.GITHUB_RUN_ATTEMPT ?? "").trim();
    if (/^[1-9]\d*$/.test(runId) && /^[1-9]\d*$/.test(runAttempt)) {
      return `github-run-${runId}-${runAttempt}`;
    }
    return fallback();
  }

  function newReviewStartLeaseOwnerForTest(env: NodeJS.ProcessEnv, fallback: () => string): string {
    return newReviewStartLeaseOwner(env, fallback);
  }

  function exactReviewQueueAuthorityFromEnv(
    env: NodeJS.ProcessEnv = process.env,
  ): ExactReviewQueueAuthority | null {
    const raw = {
      queueUrl: String(env.EXACT_REVIEW_QUEUE_URL ?? "")
        .trim()
        .replace(/\/$/, ""),
      itemKey: String(env.EXACT_REVIEW_ITEM_KEY ?? "").trim(),
      leaseId: String(env.EXACT_REVIEW_LEASE_ID ?? "").trim(),
      leaseRevision: String(env.EXACT_REVIEW_LEASE_REVISION ?? "").trim(),
      claimGeneration: String(env.EXACT_REVIEW_CLAIM_GENERATION ?? "").trim(),
      runId: String(env.GITHUB_RUN_ID ?? "").trim(),
      runAttempt: String(env.GITHUB_RUN_ATTEMPT ?? "").trim(),
      sourceHeadSha: String(env.EXACT_REVIEW_SOURCE_HEAD_SHA ?? "")
        .trim()
        .toLowerCase(),
    };
    if (
      ![raw.queueUrl, raw.itemKey, raw.leaseId, raw.leaseRevision, raw.claimGeneration].some(
        Boolean,
      )
    ) {
      return null;
    }

    let queueUrl: URL;
    try {
      queueUrl = new URL(raw.queueUrl);
    } catch {
      throw new UserFacingCommandError("EXACT_REVIEW_QUEUE_URL must be an HTTP(S) URL.");
    }
    const leaseRevision = Number(raw.leaseRevision);
    const claimGeneration = Number(raw.claimGeneration);
    const runAttempt = Number(raw.runAttempt);
    if (
      !["http:", "https:"].includes(queueUrl.protocol) ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/.test(raw.itemKey) ||
      !/^[A-Za-z0-9._:-]{1,200}$/.test(raw.leaseId) ||
      !Number.isSafeInteger(leaseRevision) ||
      leaseRevision < 1 ||
      !Number.isSafeInteger(claimGeneration) ||
      claimGeneration < 1 ||
      !/^[1-9]\d{0,29}$/.test(raw.runId) ||
      !Number.isSafeInteger(runAttempt) ||
      runAttempt < 1 ||
      (raw.sourceHeadSha !== "" && !/^[0-9a-f]{40}$/.test(raw.sourceHeadSha))
    ) {
      throw new UserFacingCommandError("Exact-review queue authority context is incomplete.");
    }
    return {
      queueUrl: queueUrl.toString().replace(/\/$/, ""),
      itemKey: raw.itemKey,
      leaseId: raw.leaseId,
      leaseRevision,
      claimGeneration,
      runId: raw.runId,
      runAttempt,
      sourceHeadSha: raw.sourceHeadSha || null,
    };
  }

  function exactReviewQueueAuthorityIsLive(authority: ExactReviewQueueAuthority): boolean {
    const payload = JSON.stringify({
      item_key: authority.itemKey,
      lease_id: authority.leaseId,
      lease_revision: authority.leaseRevision,
      claim_generation: authority.claimGeneration,
      run_id: authority.runId,
      run_attempt: authority.runAttempt,
      ...(authority.sourceHeadSha ? { source_head_sha: authority.sourceHeadSha } : {}),
    });
    const result = spawnSync(
      "curl",
      [
        "--silent",
        "--show-error",
        "--connect-timeout",
        "5",
        "--max-time",
        "20",
        "--output",
        "/dev/null",
        "--write-out",
        "%{http_code}",
        "--request",
        "POST",
        "--header",
        "content-type: application/json",
        "--data-binary",
        payload,
        `${authority.queueUrl}/internal/exact-review/heartbeat`,
      ],
      { encoding: "utf8" },
    );
    return result.status === 0 && result.stdout.trim() === "200";
  }

  function freshDedicatedReviewStartLeases(options: {
    comments: Record<string, unknown>[];
    itemNumber: number;
    headSha: string;
    nowMs: number;
  }): Array<{
    comment: Record<string, unknown>;
    startedAt: string;
    expiresAt: string;
    owner: string | null;
    commentId: number | null;
  }> {
    const trustedAuthors = new Set(
      [...PATCHABLE_REVIEW_COMMENT_AUTHORS].map((author) => author.toLowerCase()),
    );
    return (
      options.comments
        .map((comment) => {
          const lease = freshExactHeadReviewStartLease({
            comments: [comment],
            itemNumber: options.itemNumber,
            headSha: options.headSha,
            trustedAuthors,
            nowMs: options.nowMs,
          });
          return lease ? { comment, ...lease } : null;
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        // GitHub comment ids are server-assigned and monotonic. A client timestamp cannot elect the
        // winner: a delayed worker could publish an earlier timestamp after another worker acquired
        // the lease, retroactively displacing it and allowing both reviews to run.
        .sort(
          (left, right) =>
            (commentId(left.comment) ?? Number.MAX_SAFE_INTEGER) -
            (commentId(right.comment) ?? Number.MAX_SAFE_INTEGER),
        )
    );
  }

  function reviewStartLeaseWinnerCommentIdForTest(options: {
    comments: Record<string, unknown>[];
    itemNumber: number;
    headSha: string;
    nowMs: number;
  }): number | null {
    return commentId(freshDedicatedReviewStartLeases(options)[0]?.comment);
  }

  function postReviewStartStatusComment(options: {
    item: Item;
    headSha?: string;
    reviewTimeoutMs: number;
    position: number;
    total: number;
    shardIndex: number;
    shardCount: number;
    purpose?: "review" | "apply";
    queueAuthority?: ExactReviewQueueAuthority | null;
    allowSupersededLeaseCleanup?: boolean;
  }): ReviewStartStatusCommentResult {
    const startedAtMs = Date.now();
    const leaseOwner = newReviewStartLeaseOwner();
    const leaseOptions: ReviewStartStatusCommentOptions = {
      number: options.item.number,
      kind: options.item.kind,
      title: options.item.title,
      ...(options.headSha ? { headSha: options.headSha } : {}),
      startedAt: new Date(startedAtMs).toISOString(),
      leaseExpiresAt: new Date(
        startedAtMs + options.reviewTimeoutMs + 10 * 60 * 1000,
      ).toISOString(),
      leaseOwner,
      position: options.position,
      total: options.total,
      shardIndex: options.shardIndex,
      shardCount: options.shardCount,
      purpose: options.purpose ?? "review",
    };
    const normalizedHead = String(options.headSha ?? "")
      .trim()
      .toLowerCase();
    const initialState = issueReviewCommentState(options.item.number);
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(normalizedHead)) {
      throw new Error(
        `cannot acquire a review lease without the current item revision for #${options.item.number}`,
      );
    }
    const initialLease = freshDedicatedReviewStartLeases({
      comments: initialState.leaseComments,
      itemNumber: options.item.number,
      headSha: normalizedHead,
      nowMs: startedAtMs,
    })[0];
    if (initialLease) {
      return heldReviewStartStatusCommentResult(initialLease.expiresAt, false);
    }
    reapExpiredDedicatedReviewStartLeases(
      options.item.number,
      initialState.dedicatedLeaseComments,
      startedAtMs,
    );
    const body = renderReviewStartStatusComment(leaseOptions);
    const payload = writeCommentPayload(options.item.number, body);
    // Every acquisition POSTs a fresh comment: the lowest-server-id election
    // needs distinct ids per contender, so refreshing a leftover placeholder in
    // place would let two racing workers both validate ownership of the same
    // comment. Superseded placeholders are swept when the durable review
    // comment is published instead.
    const createArgs = [
      "api",
      `repos/${targetRepo()}/issues/${options.item.number}/comments`,
      "--method",
      "POST",
      "--input",
      payload,
    ];
    const created = reviewCommentFromMutationResponse(
      ghObservedMutationCommand({
        identity: `review_lease_post:${options.item.number}:${leaseOwner}`,
        args: createArgs,
      }),
      createArgs,
    );
    const createdCommentId = commentId(created);
    if (createdCommentId === null) {
      throw new Error(
        `could not identify the created review lease comment for #${options.item.number}; retry required`,
      );
    }
    const acquired = { owner: leaseOwner, commentId: createdCommentId, headSha: normalizedHead };
    const confirmedState = issueReviewCommentState(options.item.number);
    const confirmed = freshDedicatedReviewStartLeases({
      comments: confirmedState.leaseComments,
      itemNumber: options.item.number,
      headSha: normalizedHead,
      nowMs: Date.now(),
    });
    if (confirmed.length === 0) {
      deleteOwnedDedicatedReviewStartLease(options.item.number, acquired);
      throw new Error(
        `could not confirm the review lease comment for #${options.item.number}; retry required`,
      );
    }
    const winner = confirmed[0];
    if (!winner) {
      deleteOwnedDedicatedReviewStartLease(options.item.number, acquired);
      throw new Error(
        `could not identify the winning review lease for #${options.item.number}; retry required`,
      );
    }
    if (
      commentId(winner.comment) !== createdCommentId ||
      reviewStartLeaseOwner(winner.comment) !== leaseOwner
    ) {
      deleteOwnedDedicatedReviewStartLease(options.item.number, acquired);
      return heldReviewStartStatusCommentResult(winner.expiresAt, true);
    }
    if (options.queueAuthority) {
      const authoritativeHead = currentReviewRevision(options.item);
      if (authoritativeHead !== normalizedHead) {
        deleteOwnedDedicatedReviewStartLease(options.item.number, acquired);
        throw new Error(
          `review revision changed while reserving #${options.item.number}; retry required`,
        );
      }
      if (!exactReviewQueueAuthorityIsLive(options.queueAuthority)) {
        deleteOwnedDedicatedReviewStartLease(options.item.number, acquired);
        throw new Error(
          `exact-review queue authority changed while reserving #${options.item.number}; retry required`,
        );
      }
      // The candidate snapshot predates both authority checks. A newer worker
      // cannot be selected by a stale caller: if its lease is already present,
      // the live revision/queue tuple has moved; if it starts later, it is absent
      // from this immutable snapshot.
      if (options.allowSupersededLeaseCleanup) {
        reapSupersededDedicatedReviewStartLeases(
          options.item.number,
          confirmedState.dedicatedLeaseComments,
          normalizedHead,
          authoritativeHead,
        );
      } else if (pullRequestHeadSha(options.item.number) !== normalizedHead) {
        deleteOwnedDedicatedReviewStartLease(options.item.number, acquired);
        throw new Error(
          `review revision changed while reserving #${options.item.number}; retry required`,
        );
      }
    }
    return {
      status: "posted",
      lease: { ...acquired, comment: winner.comment },
      didMutate: true,
    };
  }

  function deleteOwnedDedicatedReviewStartLease(
    itemNumber: number,
    lease: AcquiredReviewStartLease,
    options: { throwOnError?: boolean } = {},
  ): boolean {
    try {
      const matching = issueReviewCommentState(itemNumber).dedicatedLeaseComments.find(
        (comment) =>
          commentId(comment) === lease.commentId &&
          reviewStartLeaseOwner(comment) === lease.owner &&
          (commentBody(comment) ?? "").includes(`sha=${lease.headSha}`),
      );
      if (!matching) return false;
      ghObservedMutationCommand({
        identity: `review_lease_delete:${itemNumber}:${lease.commentId}`,
        args: [
          "api",
          `repos/${targetRepo()}/issues/comments/${lease.commentId}`,
          "--method",
          "DELETE",
        ],
      });
      return true;
    } catch (error) {
      if (options.throwOnError) throw error;
      console.error(
        `[review] could not delete owned review lease comment ${lease.commentId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  function reapExpiredDedicatedReviewStartLeases(
    itemNumber: number,
    dedicatedLeaseComments: Record<string, unknown>[],
    nowMs: number,
  ): void {
    const expired = expiredReviewStartStatusLeases({
      comments: dedicatedLeaseComments,
      itemNumber,
      trustedAuthors: new Set(
        [...PATCHABLE_REVIEW_COMMENT_AUTHORS].map((author) => author.toLowerCase()),
      ),
      nowMs,
    });
    for (const lease of expired) {
      try {
        ghObservedMutationCommand({
          identity: `review_lease_reap:${itemNumber}:${lease.commentId}`,
          args: [
            "api",
            `repos/${targetRepo()}/issues/comments/${lease.commentId}`,
            "--method",
            "DELETE",
          ],
        });
        console.error(
          `[review] reaped expired review lease comment ${lease.commentId} for #${itemNumber} (lease expired ${lease.expiresAt})`,
        );
      } catch (error) {
        // A failed reap must never block acquiring the new lease.
        console.error(
          `[review] could not reap expired review lease comment ${lease.commentId} for #${itemNumber}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  function reapSupersededDedicatedReviewStartLeases(
    itemNumber: number,
    dedicatedLeaseComments: Record<string, unknown>[],
    currentHeadSha: string,
    authoritativeHeadSha: string,
  ): void {
    const superseded = supersededReviewStartStatusLeases({
      comments: dedicatedLeaseComments,
      itemNumber,
      headSha: currentHeadSha,
      authoritativeHeadSha,
      trustedAuthors: new Set(
        [...PATCHABLE_REVIEW_COMMENT_AUTHORS].map((author) => author.toLowerCase()),
      ),
    });
    for (const lease of superseded) {
      try {
        ghObservedMutationCommand({
          identity: `review_lease_supersede:${itemNumber}:${lease.commentId}`,
          args: [
            "api",
            `repos/${targetRepo()}/issues/comments/${lease.commentId}`,
            "--method",
            "DELETE",
          ],
        });
        console.error(
          `[review] deleted superseded review lease comment ${lease.commentId} for #${itemNumber} (reviewed head ${lease.headSha}, current head ${currentHeadSha})`,
        );
      } catch (error) {
        // A failed cleanup must never block the current revision from acquiring its lease.
        console.error(
          `[review] could not delete superseded review lease comment ${lease.commentId} for #${itemNumber}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  const REVIEW_PLACEHOLDER_BODY_PATTERN = /^ClawSweeper status: review started\./i;

  function supersededReviewPlaceholderCommentIds(options: {
    number: number;
    comments: readonly Record<string, unknown>[];
    keepCommentIds: ReadonlySet<number>;
    nowMs?: number;
  }): number[] {
    const nowMs = options.nowMs ?? Date.now();
    const ids: number[] = [];
    for (const comment of options.comments) {
      const id = commentId(comment);
      if (id === null || options.keepCommentIds.has(id)) continue;
      if (!canPatchReviewComment(comment)) continue;
      const body = (commentBody(comment) ?? "").trimStart();
      // Placeholder bodies start with the status line; the durable review
      // comment never does, and its marker is an extra guard against deletion.
      if (!REVIEW_PLACEHOLDER_BODY_PATTERN.test(body)) continue;
      if (body.includes(reviewCommentMarker(options.number))) continue;
      // An unexpired lease may belong to a racing worker on a newer revision;
      // only provably superseded placeholders (expired lease or marker-less
      // legacy body) are swept after the durable review comment is published.
      const marker = body.match(/<!--\s*clawsweeper-review-status:started\b([^>]*)-->/i);
      if (marker) {
        const expiresAtMs = Date.parse(
          marker[1]?.match(/\blease_expires_at=([^\s>]+)/i)?.[1] ?? "",
        );
        if (Number.isFinite(expiresAtMs) && expiresAtMs >= nowMs) continue;
      }
      ids.push(id);
    }
    return ids;
  }

  function cleanupSupersededReviewPlaceholderComments(options: {
    number: number;
    // Pre-mutation snapshot from the apply flow; the sweep must not refetch the
    // comment list after the durable-comment mutation (API-budget invariant).
    comments: readonly Record<string, unknown>[];
    keepCommentIds: ReadonlySet<number>;
  }): void {
    const ids = supersededReviewPlaceholderCommentIds({
      number: options.number,
      comments: options.comments,
      keepCommentIds: options.keepCommentIds,
    });
    for (const id of ids) {
      try {
        ghObservedMutationCommand({
          identity: `review_placeholder_sweep:${options.number}:${id}`,
          args: ["api", `repos/${targetRepo()}/issues/comments/${id}`, "--method", "DELETE"],
        });
        console.error(
          `[apply] deleted superseded review placeholder comment ${id} for #${options.number}`,
        );
      } catch (error) {
        if (error instanceof GitHubRuntimeBudgetError) throw error;
        // A failed sweep must never fail the publish; the next apply retries it.
        console.error(
          `[apply] could not delete superseded review placeholder comment ${id} for #${options.number}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  return {
    reviewStartLeaseOwner,
    newReviewStartLeaseOwner,
    newReviewStartLeaseOwnerForTest,
    exactReviewQueueAuthorityFromEnv,
    exactReviewQueueAuthorityIsLive,
    freshDedicatedReviewStartLeases,
    reviewStartLeaseWinnerCommentIdForTest,
    postReviewStartStatusComment,
    deleteOwnedDedicatedReviewStartLease,
    reapExpiredDedicatedReviewStartLeases,
    reapSupersededDedicatedReviewStartLeases,
    REVIEW_PLACEHOLDER_BODY_PATTERN,
    supersededReviewPlaceholderCommentIds,
    cleanupSupersededReviewPlaceholderComments,
  };
}
