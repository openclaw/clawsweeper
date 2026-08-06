import assert from "node:assert/strict";
import test from "node:test";

import {
  findReviewComments,
  hasReviewMarker,
  planReviewCommentUpsert,
  renderReviewCommentBody,
  reviewCommentMutationRequest,
} from "../dist/linear/comment.js";
import type { LinearComment, ReviewCommentUpsertInput } from "../dist/linear/comment.js";
import { authorizeMutation, resolveGates, REVIEW_ONLY_GATES } from "../dist/linear/authority.js";
import type { DriftFingerprint } from "../dist/linear/authority.js";
import { linearReviewMarker } from "../dist/linear/record.js";

// Barrel wiring check
import { planReviewCommentUpsert as planReviewCommentUpsertFromIndex } from "../dist/linear/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ISSUE_A = "issue-uuid-a";
const ISSUE_B = "issue-uuid-b";
const KEY_A = "PAR-213";
const CONTENT = "This is the review body.";

function makeInput(overrides: Partial<ReviewCommentUpsertInput> = {}): ReviewCommentUpsertInput {
  return {
    issueId: ISSUE_A,
    key: KEY_A,
    content: CONTENT,
    existingComments: [],
    expectedAuthorId: "actor-1",
    ...overrides,
  };
}

function makeComment(id: string, body: string, authorId: string | null = "actor-1"): LinearComment {
  return { id, body, authorId, authorName: authorId === null ? null : "ClawSweeper" };
}

// ---------------------------------------------------------------------------
// renderReviewCommentBody — marker-first, trimmed, throws on empty
// ---------------------------------------------------------------------------

test("renderReviewCommentBody produces marker-first body", () => {
  const body = renderReviewCommentBody(ISSUE_A, CONTENT);
  assert.ok(body.startsWith(linearReviewMarker(ISSUE_A)));
  assert.ok(body.includes(CONTENT));
});

test("renderReviewCommentBody trims leading/trailing whitespace from content", () => {
  const body = renderReviewCommentBody(ISSUE_A, `  ${CONTENT}  `);
  assert.equal(body, `${linearReviewMarker(ISSUE_A)}\n\n${CONTENT}`);
});

test("renderReviewCommentBody throws on empty string content", () => {
  assert.throws(() => renderReviewCommentBody(ISSUE_A, ""), /empty after trimming/);
});

test("renderReviewCommentBody throws on whitespace-only content", () => {
  assert.throws(() => renderReviewCommentBody(ISSUE_A, "   "), /empty after trimming/);
});

test("renderReviewCommentBody is idempotent: same inputs produce identical output", () => {
  const first = renderReviewCommentBody(ISSUE_A, CONTENT);
  const second = renderReviewCommentBody(ISSUE_A, CONTENT);
  assert.equal(first, second);
});

// ---------------------------------------------------------------------------
// hasReviewMarker — substring match, case-sensitive, isolated by issueId
// ---------------------------------------------------------------------------

test("hasReviewMarker returns true when marker is present in body", () => {
  const body = renderReviewCommentBody(ISSUE_A, CONTENT);
  assert.equal(hasReviewMarker(body, ISSUE_A), true);
});

test("hasReviewMarker returns false when marker is absent", () => {
  assert.equal(hasReviewMarker("no marker here", ISSUE_A), false);
});

test("hasReviewMarker returns false for a different issueId's marker", () => {
  const body = renderReviewCommentBody(ISSUE_A, CONTENT);
  assert.equal(hasReviewMarker(body, ISSUE_B), false);
});

// ---------------------------------------------------------------------------
// findReviewComments — returns matches in input order, isolated by issueId
// ---------------------------------------------------------------------------

test("findReviewComments returns matching comments in input order", () => {
  const bodyA = renderReviewCommentBody(ISSUE_A, CONTENT);
  const comments = [
    makeComment("c1", bodyA),
    makeComment("c2", "unrelated comment"),
    makeComment("c3", bodyA),
  ];
  const found = findReviewComments(ISSUE_A, comments, "actor-1");
  assert.deepEqual(
    found.map((c) => c.id),
    ["c1", "c3"],
  );
});

test("findReviewComments returns empty array when no markers match", () => {
  const comments = [makeComment("c1", "plain body"), makeComment("c2", "another body")];
  assert.deepEqual(findReviewComments(ISSUE_A, comments, "actor-1"), []);
});

test("findReviewComments isolates by issueId: issue-A marker not found for issue-B", () => {
  const bodyA = renderReviewCommentBody(ISSUE_A, CONTENT);
  const comments = [makeComment("c1", bodyA)];
  assert.deepEqual(findReviewComments(ISSUE_B, comments, "actor-1"), []);
});

// ---------------------------------------------------------------------------
// planReviewCommentUpsert — create / noop / update / stale duplicates
// ---------------------------------------------------------------------------

test('planReviewCommentUpsert emits "create" when no existing comments', () => {
  const plan = planReviewCommentUpsert(makeInput());
  assert.equal(plan.action, "create");
  assert.equal(plan.targetCommentId, null);
  assert.deepEqual(plan.staleDuplicateIds, []);
  assert.ok(plan.reasons.length > 0);
});

test('planReviewCommentUpsert emits "create" when comments exist but none have the marker', () => {
  const plan = planReviewCommentUpsert(
    makeInput({ existingComments: [makeComment("c1", "no marker")] }),
  );
  assert.equal(plan.action, "create");
  assert.equal(plan.targetCommentId, null);
  assert.deepEqual(plan.staleDuplicateIds, []);
});

test("planReviewCommentUpsert never updates a marker comment owned by another author", () => {
  const body = renderReviewCommentBody(ISSUE_A, "spoofed content");
  assert.throws(
    () =>
      planReviewCommentUpsert(
        makeInput({ existingComments: [makeComment("c-spoof", body, "actor-other")] }),
      ),
    /marker comment exists but is not owned by expected actor actor-1/,
  );
});

test('planReviewCommentUpsert emits "noop" when single matching comment has byte-identical body', () => {
  const body = renderReviewCommentBody(ISSUE_A, CONTENT);
  const plan = planReviewCommentUpsert(
    makeInput({ existingComments: [makeComment("c-existing", body)] }),
  );
  assert.equal(plan.action, "noop");
  assert.equal(plan.targetCommentId, "c-existing");
  assert.deepEqual(plan.staleDuplicateIds, []);
});

test('planReviewCommentUpsert emits "update" when single matching comment has stale body', () => {
  const staleBody = renderReviewCommentBody(ISSUE_A, "old content");
  const plan = planReviewCommentUpsert(
    makeInput({ existingComments: [makeComment("c-stale", staleBody)] }),
  );
  assert.equal(plan.action, "update");
  assert.equal(plan.targetCommentId, "c-stale");
  assert.equal(plan.body, renderReviewCommentBody(ISSUE_A, CONTENT));
  assert.deepEqual(plan.staleDuplicateIds, []);
});

test("planReviewCommentUpsert with multiple marker comments: keeps first, staleDuplicateIds = rest in order", () => {
  const body = renderReviewCommentBody(ISSUE_A, CONTENT);
  const comments = [makeComment("c1", body), makeComment("c2", body), makeComment("c3", body)];
  const plan = planReviewCommentUpsert(makeInput({ existingComments: comments }));
  assert.equal(plan.targetCommentId, "c1");
  assert.deepEqual(plan.staleDuplicateIds, ["c2", "c3"]);
  assert.ok(plan.reasons.some((r) => r.includes("stale duplicate")));
});

test("stale duplicates branch also works for noop disposition", () => {
  const body = renderReviewCommentBody(ISSUE_A, CONTENT);
  const comments = [makeComment("keep", body), makeComment("dup", body)];
  const plan = planReviewCommentUpsert(makeInput({ existingComments: comments }));
  assert.equal(plan.action, "noop");
  assert.equal(plan.targetCommentId, "keep");
  assert.deepEqual(plan.staleDuplicateIds, ["dup"]);
  assert.ok(plan.reasons.some((r) => r.includes("stale duplicate")));
});

test("stale duplicates branch also works for update disposition", () => {
  const staleBody = renderReviewCommentBody(ISSUE_A, "old");
  const freshBody = renderReviewCommentBody(ISSUE_A, CONTENT);
  const comments = [makeComment("keep", staleBody), makeComment("dup", freshBody)];
  const plan = planReviewCommentUpsert(makeInput({ existingComments: comments }));
  assert.equal(plan.action, "update");
  assert.equal(plan.targetCommentId, "keep");
  assert.deepEqual(plan.staleDuplicateIds, ["dup"]);
  assert.ok(plan.reasons.some((r) => r.includes("stale duplicate")));
});

test("plan always carries marker === linearReviewMarker(issueId)", () => {
  const plan = planReviewCommentUpsert(makeInput());
  assert.equal(plan.marker, linearReviewMarker(ISSUE_A));
});

test("plan always carries the key passthrough", () => {
  const plan = planReviewCommentUpsert(makeInput({ key: "MYKEY-99" }));
  assert.equal(plan.key, "MYKEY-99");
});

test("plan always has non-empty reasons", () => {
  const plan = planReviewCommentUpsert(makeInput());
  assert.ok(plan.reasons.length > 0);
  for (const r of plan.reasons) {
    assert.ok(r.trim().length > 0);
  }
});

// ---------------------------------------------------------------------------
// planHash — deterministic, excludes reasons/staleDuplicateIds, sensitive to write fields
// ---------------------------------------------------------------------------

test("planHash is deterministic: same input yields same hash across two calls", () => {
  const plan1 = planReviewCommentUpsert(makeInput());
  const plan2 = planReviewCommentUpsert(makeInput());
  assert.equal(plan1.planHash, plan2.planHash);
});

test("planHash excludes reasons/staleDuplicateIds: two create plans with same write fields share planHash", () => {
  // Both yield action "create", null targetCommentId, same body+issueId — planHash must match
  // even though one has no comments and the other has a non-matching comment.
  const plan1 = planReviewCommentUpsert(makeInput({ existingComments: [] }));
  const plan2 = planReviewCommentUpsert(
    makeInput({ existingComments: [makeComment("cx", "no marker here")] }),
  );
  assert.equal(plan1.action, "create");
  assert.equal(plan2.action, "create");
  assert.equal(plan1.planHash, plan2.planHash);
});

test("planHash is sensitive to body content: different content → different hash", () => {
  const plan1 = planReviewCommentUpsert(makeInput({ content: "content alpha" }));
  const plan2 = planReviewCommentUpsert(makeInput({ content: "content beta" }));
  assert.notEqual(plan1.planHash, plan2.planHash);
});

test("planHash is sensitive to the expected application actor", () => {
  const actorOne = planReviewCommentUpsert(makeInput({ expectedAuthorId: "actor-1" }));
  const actorTwo = planReviewCommentUpsert(makeInput({ expectedAuthorId: "actor-2" }));
  assert.equal(actorOne.expectedAuthorId, "actor-1");
  assert.equal(actorTwo.expectedAuthorId, "actor-2");
  assert.notEqual(actorOne.planHash, actorTwo.planHash);
});

test("planHash is sensitive to action/targetCommentId: create vs update → different hash", () => {
  const planCreate = planReviewCommentUpsert(makeInput());
  const staleBody = renderReviewCommentBody(ISSUE_A, "old");
  const planUpdate = planReviewCommentUpsert(
    makeInput({ existingComments: [makeComment("c1", staleBody)] }),
  );
  assert.equal(planCreate.action, "create");
  assert.equal(planUpdate.action, "update");
  assert.notEqual(planCreate.planHash, planUpdate.planHash);
});

// ---------------------------------------------------------------------------
// reviewCommentMutationRequest — bridge to authority layer
// ---------------------------------------------------------------------------

test("reviewCommentMutationRequest returns kind comment-upsert with correct fields", () => {
  const plan = planReviewCommentUpsert(makeInput());
  const req = reviewCommentMutationRequest(plan, "snap-abc");
  assert.equal(req.kind, "comment-upsert");
  assert.equal(req.key, plan.key);
  assert.equal(req.planHash, plan.planHash);
  assert.equal(req.snapshotHash, "snap-abc");
});

test("reviewCommentMutationRequest passes through an arbitrary snapshotHash", () => {
  const plan = planReviewCommentUpsert(makeInput());
  const req = reviewCommentMutationRequest(plan, "snap-xyz-unique");
  assert.equal(req.snapshotHash, "snap-xyz-unique");
});

test("AUTHORITY INTEGRATION: REVIEW_ONLY_GATES denies comment-upsert (gate closed)", () => {
  const plan = planReviewCommentUpsert(makeInput());
  const snap = "snap-auth-test";
  const req = reviewCommentMutationRequest(plan, snap);
  const drift: DriftFingerprint = { liveSnapshotHash: snap, approvedPlanHash: plan.planHash };
  const auth = authorizeMutation(req, REVIEW_ONLY_GATES, drift);
  assert.equal(auth.allowed, false);
  assert.equal(auth.gate, "comment");
});

test("AUTHORITY INTEGRATION: resolveGates({comment:true}) with matching drift allows the request", () => {
  const plan = planReviewCommentUpsert(makeInput());
  const snap = "snap-auth-test";
  const req = reviewCommentMutationRequest(plan, snap);
  const drift: DriftFingerprint = { liveSnapshotHash: snap, approvedPlanHash: plan.planHash };
  const gates = resolveGates({ comment: true });
  const auth = authorizeMutation(req, gates, drift);
  assert.equal(auth.allowed, true);
});

test("AUTHORITY INTEGRATION: mismatched approvedPlanHash is denied with plan-hash-mismatch reason", () => {
  const plan = planReviewCommentUpsert(makeInput());
  const snap = "snap-auth-test";
  const req = reviewCommentMutationRequest(plan, snap);
  const drift: DriftFingerprint = { liveSnapshotHash: snap, approvedPlanHash: "wrong-plan-hash" };
  const gates = resolveGates({ comment: true });
  const auth = authorizeMutation(req, gates, drift);
  assert.equal(auth.allowed, false);
  assert.ok(auth.reasons.some((r) => r.includes("plan hash mismatch")));
});

// ---------------------------------------------------------------------------
// Constants — GraphQL mutation strings
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Barrel wiring
// ---------------------------------------------------------------------------

test("planReviewCommentUpsert is re-exported from the linear index barrel", () => {
  assert.equal(typeof planReviewCommentUpsertFromIndex, "function");
  const plan = planReviewCommentUpsertFromIndex(makeInput());
  assert.equal(plan.action, "create");
  assert.equal(plan.issueId, ISSUE_A);
});
