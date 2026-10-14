import assert from "node:assert/strict";
import test from "node:test";
import { isExplicitReviewRequest } from "../src/maintainer-review-policy.ts";

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
