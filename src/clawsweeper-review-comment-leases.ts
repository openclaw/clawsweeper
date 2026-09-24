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

export class ReviewLeaseSupersededError extends Error {
  constructor() {
    super("Exact-review queue authority is no longer active; completing as superseded.");
    this.name = "ReviewLeaseSupersededError";
  }
}

export function createReviewCommentLeases(
  dependencies: ReviewCommentWorkflowDependencies &
    ReturnType<typeof createReviewCommentIdentity> &
    ReturnType<typeof createReviewCommentState> &
    ReturnType<typeof createReviewCommentPublication>,
) {
  const {
    targetRepo,
    heldReviewStartStatusCommentResult,
    ghObservedMutationCommand,
    currentReviewRevision,
    pullRequestHeadSha,
    renderReviewStartStatusComment,
    commandReviewStartLeaseCommentMarker,
    withReviewStartStatusLeaseIdentity,
    issueReviewCommentState,
    commentId,
    commentBody,
    PATCHABLE_REVIEW_COMMENT_AUTHORS,
    writeCommentPayload,
    reviewCommentFromMutationResponse,
    canPatchReviewComment,
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

  function assertExactReviewQueueAuthority(authority: ExactReviewQueueAuthority): void {
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
    const httpStatus = result.stdout?.trim();
    if (result.status === 0 && httpStatus === "200") return;
    if (result.status === 0 && httpStatus === "409") throw new ReviewLeaseSupersededError();
    throw new Error(
      `exact-review queue authority unavailable (${result.status === 0 ? `HTTP ${httpStatus}` : "transport failure"}); retry required`,
    );
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
    reuseCommentId?: number;
    reuseCommentMarker?: string;
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
    const wantsCommentReuse =
      options.reuseCommentId !== undefined || Boolean(options.reuseCommentMarker);
    // Reject a stale queue owner before public comments or expired-lease cleanup.
    if (options.queueAuthority) assertExactReviewQueueAuthority(options.queueAuthority);
    const initialState = issueReviewCommentState(options.item.number);
    if (wantsCommentReuse && !options.queueAuthority) {
      throw new Error(
        "an existing status comment can be reused only with exact-review queue authority",
      );
    }
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(normalizedHead)) {
      throw new Error(
        `cannot acquire a review lease without the current item revision for #${options.item.number}`,
      );
    }
    reapExpiredDedicatedReviewStartLeases(
      options.item.number,
      initialState.dedicatedLeaseComments,
      startedAtMs,
    );
    if (wantsCommentReuse) assertExactReviewQueueAuthority(options.queueAuthority!);
    const reservationState = !wantsCommentReuse
      ? initialState
      : issueReviewCommentState(options.item.number);
    const reusableComment = !wantsCommentReuse
      ? undefined
      : ((options.reuseCommentId === undefined
          ? undefined
          : reservationState.comments.find(
              (comment) => commentId(comment) === options.reuseCommentId,
            )) ??
        (options.reuseCommentMarker
          ? reservationState.comments.find(
              (comment) =>
                canPatchReviewComment(comment) &&
                (commentBody(comment) ?? "").includes(options.reuseCommentMarker!),
            )
          : undefined));
    const reusableCommentId = commentId(reusableComment);
    const reusableBody = commentBody(reusableComment) ?? "";
    if (
      wantsCommentReuse &&
      (!reusableComment ||
        reusableCommentId === null ||
        !canPatchReviewComment(reusableComment) ||
        !/<!--\s*clawsweeper-command-(?:ack|status):/i.test(reusableBody))
    ) {
      throw new Error(
        `command status comment ${options.reuseCommentId} cannot carry the review lease for #${options.item.number}`,
      );
    }
    const commandProgress =
      /<!--\s*clawsweeper-command-progress:start\s*-->([\s\S]*?)<!--\s*clawsweeper-command-progress:end\s*-->/i.exec(
        reusableBody,
      )?.[1] ?? "";
    const commandState = /^- State:\s*(.+)$/im.exec(commandProgress)?.[1]?.trim();
    if (
      reusableComment &&
      commandState &&
      !new Set(["Queued", "Waiting", "Review in progress"]).has(commandState)
    ) {
      throw new ReviewLeaseSupersededError();
    }
    const initialLease = freshDedicatedReviewStartLeases({
      comments: reservationState.leaseComments,
      itemNumber: options.item.number,
      headSha: normalizedHead,
      nowMs: startedAtMs,
    })[0];
    if (initialLease) {
      const id = commentId(initialLease.comment);
      if (options.queueAuthority && initialLease.owner === leaseOwner && id !== null) {
        const acquired = { owner: leaseOwner, commentId: id, headSha: normalizedHead };
        confirmQueueAuthority(acquired);
        return {
          status: "posted",
          lease: { ...acquired, comment: initialLease.comment },
          didMutate: true,
        };
      }
      return heldReviewStartStatusCommentResult(initialLease.expiresAt, false);
    }
    const body = reusableComment
      ? withReviewStartStatusLeaseIdentity(
          reusableBody,
          leaseOptions,
          commandReviewStartLeaseCommentMarker(options.item.number),
        )
      : renderReviewStartStatusComment(leaseOptions);
    const payload = writeCommentPayload(options.item.number, body);
    // Every new acquisition POSTs a fresh comment: the lowest-server-id election
    // needs distinct ids per contender, so refreshing a leftover placeholder in
    // place would let two racing workers both validate ownership of the same
    // comment. Only the same authorized run may reuse its own active lease.
    // Publication never deletes competing lease comments because a
    // rolling-version worker may still renew them.
    const createArgs = reusableComment
      ? [
          "api",
          `repos/${targetRepo()}/issues/comments/${reusableCommentId}`,
          "--method",
          "PATCH",
          "--input",
          payload,
        ]
      : [
          "api",
          `repos/${targetRepo()}/issues/${options.item.number}/comments`,
          "--method",
          "POST",
          "--input",
          payload,
        ];
    const created = reviewCommentFromMutationResponse(
      ghObservedMutationCommand({
        identity: `review_lease_${reusableComment ? "reuse" : "post"}:${options.item.number}:${leaseOwner}`,
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
      const authoritativeHead = confirmQueueAuthority(acquired);
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

    function confirmQueueAuthority(lease: AcquiredReviewStartLease): string {
      const authoritativeHead = currentReviewRevision(options.item);
      try {
        if (authoritativeHead !== normalizedHead) throw new ReviewLeaseSupersededError();
        assertExactReviewQueueAuthority(options.queueAuthority!);
      } catch (error) {
        // Keep our lease on transport failure so this run retries the check,
        // not the public POST. A definitive loss of ownership releases it.
        if (error instanceof ReviewLeaseSupersededError) {
          deleteOwnedDedicatedReviewStartLease(options.item.number, lease);
        }
        throw error;
      }
      return authoritativeHead;
    }
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
      if (/<!--\s*clawsweeper-command-(?:ack|status):/i.test(commentBody(matching) ?? "")) {
        return false;
      }
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
      const leaseComment = dedicatedLeaseComments.find(
        (comment) => commentId(comment) === lease.commentId,
      );
      if (/<!--\s*clawsweeper-command-(?:ack|status):/i.test(commentBody(leaseComment) ?? "")) {
        continue;
      }
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
      const leaseComment = dedicatedLeaseComments.find(
        (comment) => commentId(comment) === lease.commentId,
      );
      if (/<!--\s*clawsweeper-command-(?:ack|status):/i.test(commentBody(leaseComment) ?? "")) {
        continue;
      }
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

  return {
    reviewStartLeaseOwner,
    newReviewStartLeaseOwner,
    newReviewStartLeaseOwnerForTest,
    exactReviewQueueAuthorityFromEnv,
    freshDedicatedReviewStartLeases,
    reviewStartLeaseWinnerCommentIdForTest,
    postReviewStartStatusComment,
    deleteOwnedDedicatedReviewStartLease,
    reapExpiredDedicatedReviewStartLeases,
    reapSupersededDedicatedReviewStartLeases,
  };
}
