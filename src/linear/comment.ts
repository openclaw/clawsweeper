/**
 * Linear marker-backed review-comment upsert planner (deterministic, offline, pure).
 *
 * Doctrine — read, write, propose; never the other way round:
 *   This module plans the create-or-update of a single durable marker-keyed review
 *   comment per Linear issue. It decides *what* the comment body should be and
 *   *which action* is required (create / update / noop); it never applies that
 *   action. A downstream deterministic script (never Codex, never a review run)
 *   holds the short-lived token and applies the plan. Every function is a pure
 *   function of its inputs — no network, no clock, no I/O.
 *
 * Single durable comment, marker-keyed:
 *   Each issue gets exactly one ClawSweeper review comment, identified by the
 *   `<!-- clawsweeper-review:<issueId> -->` HTML marker from linearReviewMarker().
 *   On a re-plan the planner finds that comment (if it exists), compares its body
 *   to the newly rendered body, and emits a noop when they match or an update when
 *   they drift. If multiple marker-matching comments exist (stale duplicates), the
 *   first is kept and the rest are surfaced in staleDuplicateIds for clean-up.
 *
 * Authority gate — comment gate defaults closed:
 *   The comment-upsert MutationKind is governed by the "comment" gate in
 *   authority.ts, which defaults to false. This module produces a plan and a
 *   MutationRequest; the authority layer decides whether the plan may be applied.
 *   Producing a plan never implies applying it.
 *
 * planHash fingerprints the write, not the reasons:
 *   The hash covers { action, issueId, targetCommentId, body } only. Reasons and
 *   staleDuplicateIds are excluded so a re-plan that yields the same write produces
 *   the same hash and the operator-approved hash remains valid across re-plans that
 *   produce identical output.
 */

import { createHash } from "node:crypto";

import type { MutationRequest } from "./authority.js";
import { linearReviewMarker } from "./record.js";

/** Minimal shape of a comment read from a Linear issue. */
export interface LinearComment {
  id: string;
  body: string;
  authorId: string | null;
  authorName: string | null;
}

export type ReviewCommentAction = "create" | "update" | "noop";

/** The deterministic plan for a single review-comment upsert. */
export interface ReviewCommentPlan {
  action: ReviewCommentAction;
  issueId: string;
  key: string; // issue identifier (e.g. "PAR-123") — for receipts and reasons
  marker: string; // the durable HTML marker, from linearReviewMarker(issueId)
  body: string; // the full comment body that would be written (marker + content)
  targetCommentId: string | null; // id of the comment to update, null for create
  staleDuplicateIds: string[]; // ids of extra marker-matching comments to clean up
  planHash: string; // sha256 over { action, issueId, targetCommentId, body }
  reasons: string[]; // ordered, non-empty, human-readable action rationale
}

/** Inputs to planReviewCommentUpsert. */
export interface ReviewCommentUpsertInput {
  issueId: string;
  key: string; // issue identifier (e.g. "PAR-123")
  content: string; // the review body, without the marker (added by the planner)
  existingComments: LinearComment[]; // all comments currently on the issue
  expectedAuthorId?: string | null; // stable bot actor id; required to reuse a marker comment
}

/**
 * Renders the full comment body: the durable marker followed by the trimmed content.
 * Throws if content trims to empty — a marker-only comment is not a valid review.
 * Idempotent: same (issueId, content) inputs always yield byte-identical output.
 */
export function renderReviewCommentBody(issueId: string, content: string): string {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    throw new Error("renderReviewCommentBody: content must not be empty after trimming");
  }
  return `${linearReviewMarker(issueId)}\n\n${trimmed}`;
}

/**
 * Returns true iff body contains linearReviewMarker(issueId) as a case-sensitive
 * substring. Does not parse HTML — a literal substring match is sufficient and stable.
 */
export function hasReviewMarker(body: string, issueId: string): boolean {
  return body.includes(linearReviewMarker(issueId));
}

/**
 * Returns all comments whose body contains the durable marker for issueId, preserving
 * the input order. An empty array means no marker-matching comment exists yet.
 */
export function findReviewComments(
  issueId: string,
  comments: LinearComment[],
  expectedAuthorId: string,
): LinearComment[] {
  return comments.filter(
    (comment) => comment.authorId === expectedAuthorId && hasReviewMarker(comment.body, issueId),
  );
}

// Deterministic sha256 over a canonical object; mirrors linearReviewSnapshotHash in record.ts.
function planHashFor(
  action: ReviewCommentAction,
  issueId: string,
  targetCommentId: string | null,
  body: string,
): string {
  const canonical = { action, issueId, targetCommentId, body };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Plans the review-comment upsert for a single issue. Pure and offline.
 *
 * Logic:
 *   1. Render the target body (marker + trimmed content).
 *   2. Find all existing marker-matching comments.
 *   3. No matches → action "create", targetCommentId null, no stale duplicates.
 *   4. One or more matches → keep = matches[0] (the durable comment).
 *      staleDuplicateIds = rest.
 *      keep.body === body → action "noop" (already up to date).
 *      keep.body !== body → action "update".
 *   5. planHash covers { action, issueId, targetCommentId, body } only.
 *   6. reasons is a non-empty ordered list of human-readable lines.
 */
export function planReviewCommentUpsert(input: ReviewCommentUpsertInput): ReviewCommentPlan {
  const { issueId, key, content, existingComments } = input;
  const marker = linearReviewMarker(issueId);
  const body = renderReviewCommentBody(issueId, content);
  const markerComments = existingComments.filter((comment) =>
    hasReviewMarker(comment.body, issueId),
  );
  const expectedAuthorId = input.expectedAuthorId?.trim() ?? "";
  if (markerComments.length > 0 && expectedAuthorId === "") {
    throw new Error("expectedAuthorId is required to reuse an existing marker comment");
  }
  const matches = findReviewComments(issueId, existingComments, expectedAuthorId);
  if (markerComments.length > 0 && matches.length === 0) {
    throw new Error(
      `marker comment exists but is not owned by expected actor ${expectedAuthorId} — refusing to create a duplicate`,
    );
  }

  let action: ReviewCommentAction;
  let targetCommentId: string | null;
  let staleDuplicateIds: string[];
  const reasons: string[] = [];

  if (matches.length === 0) {
    action = "create";
    targetCommentId = null;
    staleDuplicateIds = [];
    reasons.push("no existing review comment — create");
  } else {
    // matches.length > 0, so the first element is always present.
    const [keep, ...rest] = matches as [LinearComment, ...LinearComment[]];
    staleDuplicateIds = rest.map((c) => c.id);
    if (keep.body === body) {
      action = "noop";
      targetCommentId = keep.id;
      reasons.push(`review comment ${keep.id} is current — noop`);
    } else {
      action = "update";
      targetCommentId = keep.id;
      reasons.push(`review comment ${keep.id} drifted — update`);
    }
    if (staleDuplicateIds.length > 0) {
      reasons.push(
        `${staleDuplicateIds.length} stale duplicate review comment(s) detected — clean up separately`,
      );
    }
  }

  const planHash = planHashFor(action, issueId, targetCommentId, body);
  return {
    action,
    issueId,
    key,
    marker,
    body,
    targetCommentId,
    staleDuplicateIds,
    planHash,
    reasons,
  };
}

/**
 * Bridges a ReviewCommentPlan to the authority layer as a MutationRequest.
 * The caller supplies snapshotHash (from the record snapshot at plan time).
 * Kind is always "comment-upsert", governed by the "comment" gate in authority.ts.
 */
export function reviewCommentMutationRequest(
  plan: ReviewCommentPlan,
  snapshotHash: string,
): MutationRequest {
  return {
    kind: "comment-upsert",
    key: plan.key,
    snapshotHash,
    planHash: plan.planHash,
  };
}

// GraphQL mutation strings applied by a deterministic short-lived-token script, never here.

/** Creates a new comment on a Linear issue. Applied downstream, not in this module. */
export const COMMENT_CREATE_MUTATION = `mutation CreateComment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id body } } }`;

/** Updates the body of an existing Linear comment. Applied downstream, not in this module. */
export const COMMENT_UPDATE_MUTATION = `mutation UpdateComment($id: String!, $body: String!) { commentUpdate(id: $id, input: { body: $body }) { success comment { id body } } }`;
