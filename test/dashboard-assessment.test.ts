import assert from "node:assert/strict";
import test from "node:test";
import { attentionGroup, classifyAssessment } from "../dashboard-site/scripts/attention.ts";
import { assessmentEvidence, assessmentReviewAge } from "../dashboard-site/src/lib/assessment.ts";

const now = Date.parse("2026-10-30T23:00:00Z");
const reviewed = "2026-10-30T20:00:00.000Z";
const head = "a".repeat(40);
const snapshot = "b".repeat(64);
const revision = "c".repeat(64);
// Fields emitted by clawsweeper-report-document.ts, not a synthetic current receipt.
const record = {
  type: "pull_request",
  state_at_review: "open",
  reviewed_at: reviewed,
  review_status: "complete",
  review_terminal_failure: "false",
  pull_head_sha: head,
  item_snapshot_hash: snapshot,
  item_source_revision: revision,
};
const classify = (attrs = {}, archived = false) =>
  classifyAssessment({ ...record, ...attrs }, archived, now);

test("complete emitted source identities describe review time, not current validity", () => {
  const result = classify();
  assert.equal(result.lifecycle, "open_at_review");
  assert.equal(result.sourceValidity, "reviewed_snapshot");
  assert.equal(result.stateObservedAt, reviewed);
  assert.equal(result.sourceObservedAt, null);
  assert.equal(attentionGroup(result), "open");
  assert.match(assessmentEvidence(result).source, /current validity unknown/);
  assert.doesNotMatch(JSON.stringify(result), /matching|current/);
});

test("old unresolved flags remain open; age does not resolve or archive them", () => {
  const result = classify({ reviewed_at: "2026-01-01T00:00:00Z" });
  assert.equal(result.lifecycle, "open_at_review");
  assert.equal(attentionGroup(result), "open");
  assert.equal(result.reviewedAt, "2026-01-01T00:00:00.000Z");
});

test("head and snapshot drift require re-verification, not clearance", () => {
  for (const attrs of [
    { current_pull_head_sha: "d".repeat(40) },
    { current_item_snapshot_hash: "e".repeat(64) },
    { action_taken: "skipped_changed_since_review" },
    { action_taken: "skipped_stale_head" },
    { action_taken: "skipped_stale_revision" },
    { review_status: "stale_reopened" },
  ]) {
    const result = classify({ ...attrs, apply_checked_at: reviewed });
    assert.equal(result.sourceValidity, "changed");
    assert.equal(attentionGroup(result), "changed");
    // Generic apply time is not a source-comparison receipt.
    assert.equal(result.sourceObservedAt, null);
  }
});

test("equal or absent current fields and generic apply checks never certify matching source", () => {
  for (const attrs of [
    {},
    { current_pull_head_sha: head, current_item_snapshot_hash: snapshot },
    { action_taken: "kept_open", apply_checked_at: reviewed },
  ]) {
    const result = classify(attrs);
    assert.equal(result.sourceValidity, "reviewed_snapshot");
    assert.equal(result.lifecycle, "open_at_review");
    assert.equal(result.sourceObservedAt, null);
  }
});

test("archive or explicitly closed state is historical even with security/source flags", () => {
  for (const [attrs, archived] of [
    [{}, true],
    [{ current_state: "closed" }, false],
    [{ current_state: "merged" }, false],
  ] as const) {
    const result = classify({ ...attrs, current_pull_head_sha: "d".repeat(40) }, archived);
    assert.equal(result.lifecycle, "historical");
    assert.equal(attentionGroup(result), "historical");
    assert.doesNotMatch(assessmentEvidence(result).state, /resolved|cleared/i);
  }
});

test("recorded open observation requires a valid reconciliation timestamp", () => {
  const result = classify({ current_state: "open", reconciled_at: "2026-10-30T21:00:00Z" });
  assert.equal(result.lifecycle, "observed_open");
  assert.equal(result.stateObservedAt, "2026-10-30T21:00:00.000Z");
  for (const reconciled_at of [undefined, "unknown", "invalid", "2027-01-01T00:00:00Z"])
    assert.equal(classify({ current_state: "open", reconciled_at }).lifecycle, "open_at_review");
});

test("unarchived location alone is not evidence of open state", () => {
  const result = classifyAssessment({}, false, now);
  assert.equal(result.lifecycle, "unknown");
  assert.equal(result.reviewStatus, "unknown");
  assert.equal(result.sourceValidity, "unknown");
  assert.equal(attentionGroup(result), "unknown");
});

test("incomplete, legacy, malformed and missing-source evidence stays explicit", () => {
  for (const attrs of [
    { review_status: "failed" },
    { review_status: "unknown" },
    { review_terminal_failure: "true" },
    { reviewed_at: "unknown" },
    { reviewed_at: "2027-01-01T00:00:00Z" },
    { pull_head_sha: "unknown" },
    { item_snapshot_hash: "untrusted text" },
    { item_source_revision: null },
  ])
    assert.equal(classify(attrs).sourceValidity, "unknown");
  assert.equal(attentionGroup(classify({ review_status: "failed" })), "unknown");
  assert.equal(attentionGroup(), "unknown");
  assert.match(assessmentEvidence().state, /unavailable/);
});

test("issue review identities do not require a PR head", () => {
  const result = classify({ type: "issue", pull_head_sha: "unknown" });
  assert.equal(result.sourceValidity, "reviewed_snapshot");
  assert.equal(result.reviewedHead, null);
});

test("only validated SHA values leave the classifier; no raw metadata leaks", () => {
  const attrs = { ...record, pull_head_sha: "https://private.invalid/token", author: "private" };
  const result = classifyAssessment(attrs, false, now);
  assert.equal(result.reviewedHead, null);
  assert(!JSON.stringify(result).includes("private"));
  assert.equal(classify({ pull_head_sha: head.toUpperCase() }).reviewedHead, head);
});

test("review age is snapshot-relative and never a resolution/freshness claim", () => {
  assert.equal(
    assessmentReviewAge(reviewed, "2026-10-30T23:00:00Z"),
    "Less than 1d old at snapshot",
  );
  assert.equal(
    assessmentReviewAge("2026-01-01T00:00:00Z", "2026-10-30T23:00:00Z"),
    "302d old at snapshot",
  );
  assert.equal(assessmentReviewAge(null, reviewed), "Age unknown");
  assert.equal(assessmentReviewAge(reviewed, null), "Age unknown");
  assert.equal(assessmentReviewAge("2027-01-01", reviewed), "Age unknown");
});
