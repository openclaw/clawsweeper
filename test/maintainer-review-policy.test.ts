import assert from "node:assert/strict";
import test from "node:test";
import { resolveReviewAuthority } from "../dist/review-authority.js";
import {
  isAuthorReadOnlyCommandAllowed,
  isMaintainerCommandAllowed,
} from "../dist/repair/comment-router/admission.js";
import {
  authorReviewCohort,
  isExplicitReviewRequest,
  MAINTAINER_AUTOMATIC_FIRST_REVIEW_FROM,
  requesterHasMaintainerReviewAuthority,
  requiresMaintainerReviewRequest,
} from "../src/maintainer-review-policy.ts";

const authorityNow = Date.parse("2026-10-30T08:00:00Z");
function authority(
  value?: unknown,
  overrides: Partial<Parameters<typeof resolveReviewAuthority>[0]> = {},
) {
  const subject = {
    repository: overrides.repository ?? "example/project",
    actor: overrides.actor ?? "author",
  };
  return resolveReviewAuthority({
    ...subject,
    now: authorityNow,
    maxAgeMs: 60_000,
    ...(value === undefined
      ? {}
      : {
          repositoryPermission: {
            ...subject,
            observedAt: new Date(authorityNow).toISOString(),
            value,
          },
        }),
    ...overrides,
  });
}

test("canonical roles separate author cohorts from requester maintainer authority", () => {
  for (const role of ["admin", "maintain", "write", "triage", "read", "none"]) {
    const permission = role === "maintain" ? "write" : role === "triage" ? "read" : role;
    const result = authority({ permission, role_name: role, user: { login: "author" } });
    const maintainer = role === "admin" || role === "maintain";
    assert.equal(authorReviewCohort(result), maintainer ? "maintainer" : "ordinary");
    assert.equal(requesterHasMaintainerReviewAuthority(result), maintainer);
  }
  const owner = authority(undefined, {
    organizationMembership: {
      repository: "example/project",
      actor: "author",
      observedAt: new Date(authorityNow).toISOString(),
      value: {
        state: "active",
        role: "admin",
        user: { login: "author" },
        organization: { login: "example" },
      },
    },
  });
  assert.equal(owner.reason, "organization_owner");
  assert.equal(authorReviewCohort(owner), "maintainer");
  assert.equal(requesterHasMaintainerReviewAuthority(owner), true);
});

test("every canonical unknown reason selects ordinary review without changing evidence", () => {
  const admin = { permission: "admin", role_name: "admin", user: { login: "author" } };
  const cases = [
    [authority(), "unavailable"],
    [authority({ user: { login: "author" } }), "invalid_evidence"],
    [authority({ ...admin, user: { login: "someone-else" } }), "subject_mismatch"],
    [authority(admin, { now: authorityNow + 60_001 }), "stale_evidence"],
    [authority({ ...admin, permission: "write" }), "contradictory_evidence"],
    [authority({ permission: "write", user: { login: "author" } }), "ambiguous_repository_role"],
  ] as const;
  for (const [result, reason] of cases) {
    const before = structuredClone(result);
    Object.freeze(result);
    assert.equal(result.role, "unknown");
    assert.equal(result.reason, reason);
    assert.equal(authorReviewCohort(result), "ordinary");
    assert.equal(requesterHasMaintainerReviewAuthority(result), false);
    assert.deepEqual(result, before);
  }
});

test("author and requester authority stay separate in both directions", () => {
  const author = authority();
  const requester = authority(
    { permission: "write", role_name: "maintain", user: { login: "requester" } },
    { actor: "requester" },
  );
  assert.equal(requester.actor, "requester");
  assert.equal(requesterHasMaintainerReviewAuthority(requester), true);
  assert.equal(authorReviewCohort(author), "ordinary");
  assert.equal(author.role, "unknown");
  assert.equal(author.reason, "unavailable");
  assert.equal(author.actor, "author");
  const unknownRequester = authority(undefined, { actor: "requester" });
  const maintainerAuthor = authority({
    permission: "write",
    role_name: "maintain",
    user: { login: "author" },
  });
  assert.equal(authorReviewCohort(maintainerAuthor), "maintainer");
  assert.equal(requesterHasMaintainerReviewAuthority(unknownRequester), false);
});

test("inert role projections leave legacy command rights and maintainer holds separate", () => {
  const unknown = authority();
  const write = authority({ permission: "write", role_name: "write", user: { login: "author" } });
  assert.equal(requesterHasMaintainerReviewAuthority(write), false);
  assert.equal(
    isMaintainerCommandAllowed({
      authorAssociation: "CONTRIBUTOR",
      repositoryPermission: "write",
      allowedAssociations: [],
    }),
    true,
  );
  assert.equal(
    isAuthorReadOnlyCommandAllowed({
      command: { intent: "re_review", author: "author" },
      target: { author: "author" },
    }),
    true,
  );
  // The existing fallback is deliberately not migrated by this inert preparation.
  assert.equal(requesterHasMaintainerReviewAuthority(unknown), false);
  assert.equal(
    isMaintainerCommandAllowed({
      authorAssociation: "OWNER",
      repositoryPermission: null,
      allowedAssociations: ["OWNER"],
    }),
    true,
  );
  const protectedItem = { author_association: "MEMBER", labels: ["maintainer"] };
  assert.equal(authorReviewCohort(unknown), "ordinary");
  assert.equal(requiresMaintainerReviewRequest(protectedItem), true);
});

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
