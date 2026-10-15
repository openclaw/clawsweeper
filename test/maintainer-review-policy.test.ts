import assert from "node:assert/strict";
import test from "node:test";
import {
  isExplicitReviewRequest,
  MAINTAINER_AUTOMATIC_FIRST_REVIEW_FROM,
  requiresMaintainerReviewRequest,
} from "../src/maintainer-review-policy.ts";

// The verified command fields of openclaw/clawsweeper#1969's re-review request.
const request = {
  sourceAction: "re_review",
  supersedesInProgress: false,
  sourceCommentVerified: true,
  sourceCommentId: 6150293296,
  sourceCommentUpdatedAt: "2026-10-13T16:32:00Z",
  commandBodyDigest: "6d816f19b629d323aebcd9488e23566d0ee80b236e0d17f8c2635df55039c6b4",
  commandOrigin: "hosted_webhook",
  commandStatusMarker:
    "<!-- clawsweeper-command-status:1969:re_review:command-6150293296-mv6wf9xc-6d816f19b629d323aebcd9488e23566d0ee80b236e0d17f8c2635df55039c6b4 -->",
};
// Both requeue producers copy the claimed decision and change only these fields.
const requeued = { ...request, sourceAction: "source_drift_requeue", supersedesInProgress: true };
const { commandStatusMarker: _marker, ...requeuedWithoutStatus } = requeued;

test("a source-drift requeue continues the unpublished explicit request", () => {
  assert.equal(isExplicitReviewRequest(request), true);
  assert.equal(isExplicitReviewRequest(requeued), true);
  assert.equal(isExplicitReviewRequest({ ...requeuedWithoutStatus, statusCommentId: 7051 }), true);
});

test("a source-drift requeue without the request's status or verification stays automatic", () => {
  assert.equal(isExplicitReviewRequest(requeuedWithoutStatus), false);
  assert.equal(isExplicitReviewRequest({ ...requeued, sourceCommentVerified: false }), false);
  assert.equal(isExplicitReviewRequest({ ...requeued, commandOrigin: "scheduled" }), false);
  assert.equal(isExplicitReviewRequest({ ...requeued, commandBodyDigest: "a".repeat(63) }), false);
  assert.equal(isExplicitReviewRequest({ ...requeued, sourceCommentId: 0 }), false);
  for (const sourceAction of ["synchronize", "edited", "scheduled_normal_backfill"]) {
    assert.equal(isExplicitReviewRequest({ ...request, sourceAction }), false, sourceAction);
  }
});

test("maintainer items created from the cutover are admitted like everyone else's", () => {
  const cutover = Date.parse(MAINTAINER_AUTOMATIC_FIRST_REVIEW_FROM);
  const before = new Date(cutover - 1).toISOString();
  const member = { author_association: "MEMBER", labels: [] };
  const labelled = { author_association: "CONTRIBUTOR", labels: [{ name: "maintainer" }] };
  for (const item of [member, labelled]) {
    assert.equal(requiresMaintainerReviewRequest({ ...item, created_at: before }), true);
    assert.equal(
      requiresMaintainerReviewRequest({
        ...item,
        created_at: MAINTAINER_AUTOMATIC_FIRST_REVIEW_FROM,
      }),
      false,
    );
    // An unknown creation time keeps the request-only rule.
    assert.equal(requiresMaintainerReviewRequest(item), true);
  }
  // Planner items carry camelCase fields.
  assert.equal(
    requiresMaintainerReviewRequest({
      authorAssociation: "OWNER",
      labels: [],
      createdAt: "2026-10-16T00:00:00Z",
    }),
    false,
  );
});
