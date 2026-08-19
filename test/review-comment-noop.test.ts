import assert from "node:assert/strict";
import test from "node:test";
import { normalizeNoopReviewMarkerMetadata } from "../dist/clawsweeper-review-comment-state.js";

const marker = () =>
  `<!-- clawsweeper-review-version item=41 reviewed_at=2026-08-09T21:12:00Z sha=na source_revision=${"a".repeat(64)} lease_owner=run-1 lease_comment_id=101 v=1 -->`;

test("no-op public identity ignores only review clock and lease metadata", () => {
  const prior = marker();
  const refreshed = prior
    .replace("21:12:00", "21:32:00")
    .replace("run-1", "run-2")
    .replace("101", "102");
  assert.equal(
    normalizeNoopReviewMarkerMetadata(prior),
    normalizeNoopReviewMarkerMetadata(refreshed),
  );
});

test("no-op public identity preserves semantic source and verdict markers", () => {
  const prior = marker();
  assert.notEqual(
    normalizeNoopReviewMarkerMetadata(prior),
    normalizeNoopReviewMarkerMetadata(prior.replace("a".repeat(64), "b".repeat(64))),
  );
  const keepOpen = `<!-- clawsweeper-verdict:keep-open item=41 reviewed_at=2026-08-09T21:12:00Z confidence=high -->`;
  assert.notEqual(
    normalizeNoopReviewMarkerMetadata(keepOpen),
    normalizeNoopReviewMarkerMetadata(keepOpen.replace("keep-open", "needs-human")),
  );
});
