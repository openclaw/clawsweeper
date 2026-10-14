import assert from "node:assert/strict";
import test from "node:test";
import { resolveReviewAuthority } from "../dist/review-authority.js";
import type { ReviewAuthorityObservation } from "../src/review-authority.ts";

const subject = { repository: "example/project", actor: "reviewer" };
const observedAt = "2026-10-13T12:00:00Z";
const clock = { now: Date.parse(observedAt), maxAgeMs: 60_000 };
const flags = (role: string) => {
  const order = ["admin", "maintain", "write", "triage", "read", "none"];
  const index = order.indexOf(role);
  return Object.fromEntries(
    ["admin", "maintain", "push", "triage", "pull"].map((flag, i) => [flag, i >= index]),
  );
};
function permission(
  role_name: string | undefined,
  permission: string,
  permissions?: Record<string, unknown>,
): ReviewAuthorityObservation {
  return {
    ...subject,
    observedAt,
    value: { role_name, permission, user: { login: subject.actor, permissions } },
  };
}
function membership(role = "admin", state = "active"): ReviewAuthorityObservation {
  return {
    ...subject,
    observedAt,
    value: { role, state, user: { login: subject.actor }, organization: { login: "example" } },
  };
}
function resolve(
  repositoryPermission?: ReviewAuthorityObservation,
  organizationMembership?: ReviewAuthorityObservation,
) {
  return resolveReviewAuthority({
    ...subject,
    ...clock,
    ...(repositoryPermission ? { repositoryPermission } : {}),
    ...(organizationMembership ? { organizationMembership } : {}),
  });
}

test("built-in effective roles distinguish maintain from legacy write", () => {
  for (const [role, legacy, expected] of [
    ["admin", "admin", "maintainer"],
    ["maintain", "write", "maintainer"],
    ["write", "write", "ordinary"],
    ["triage", "read", "ordinary"],
    ["read", "read", "ordinary"],
    ["none", "none", "ordinary"],
  ]) {
    assert.equal(resolve(permission(role, legacy!, flags(role!))).role, expected);
    assert.equal(resolve(permission(role, legacy!)).role, expected);
  }
});

test("custom roles use effective base flags, never their name", () => {
  assert.equal(
    resolve(permission("project-reviewer", "write", flags("maintain"))).role,
    "maintainer",
  );
  assert.equal(resolve(permission("super-admin", "write", flags("write"))).role, "ordinary");
  assert.equal(
    resolve(permission("project-reviewer", "write")).reason,
    "ambiguous_repository_role",
  );
  assert.equal(resolve(permission(undefined, "write")).role, "unknown");
  assert.equal(resolve(permission(undefined, "admin")).role, "maintainer");
  assert.equal(resolve(permission("reader", "read")).role, "ordinary");
});

test("incomplete and contradictory permission facts never grant authority", () => {
  for (const observation of [
    permission("maintain", "admin"),
    permission("admin", "write"),
    permission("write", "write", flags("maintain")),
    permission("maintain", "write", { maintain: true }),
    permission("maintain", "write", { ...flags("maintain"), pull: false }),
    permission("custom", "write", { ...flags("write"), admin: "true" }),
    permission("maintain", "maintain"),
    permission("", "write"),
  ])
    assert.equal(resolve(observation).role, "unknown");
});

test("organization ownership requires active bound membership", () => {
  assert.equal(resolve(undefined, membership()).reason, "organization_owner");
  assert.equal(resolve(permission("admin", "admin"), membership()).role, "maintainer");
  assert.equal(resolve(undefined, membership("admin", "pending")).role, "unknown");
  assert.equal(resolve(undefined, membership("member")).role, "unknown");
  assert.equal(resolve(undefined, membership("owner")).role, "unknown");
  assert.equal(resolve(permission("read", "read"), membership()).reason, "contradictory_evidence");
  assert.equal(resolve(permission("maintain", "write"), membership("member")).role, "maintainer");
});

test("observations cannot move between authors, requestors, repositories, or organizations", () => {
  for (const observation of [
    { ...permission("admin", "admin"), actor: "someone-else" },
    { ...permission("admin", "admin"), repository: "example/other" },
    {
      ...permission("admin", "admin"),
      value: { permission: "admin", user: { login: "someone-else" } },
    },
  ])
    assert.equal(resolve(observation).reason, "subject_mismatch");
  assert.equal(
    resolve(undefined, {
      ...membership(),
      value: {
        role: "admin",
        state: "active",
        user: { login: subject.actor },
        organization: { login: "other" },
      },
    }).reason,
    "subject_mismatch",
  );
  assert.equal(
    resolveReviewAuthority({
      ...subject,
      actor: "requestor",
      ...clock,
      repositoryPermission: permission("admin", "admin"),
    }).role,
    "unknown",
  );
});

test("stale, future, missing and malformed evidence remain explicit unknowns", () => {
  assert.equal(resolve().reason, "unavailable");
  for (const timestamp of ["invalid", "2026-10-13T12:00:01Z", "2026-10-13T11:58:59Z"]) {
    assert.equal(
      resolve({ ...permission("admin", "admin"), observedAt: timestamp }).reason,
      "stale_evidence",
    );
  }
  assert.equal(resolve({ ...permission("admin", "admin"), value: null }).role, "unknown");
  assert.equal(resolveReviewAuthority({ ...subject, ...clock, maxAgeMs: -1 }).role, "unknown");
  assert.equal(
    resolveReviewAuthority({ ...subject, ...clock, actor: " reviewer" }).role,
    "unknown",
  );
});

test("case-insensitive GitHub identities remain bound", () => {
  assert.equal(
    resolveReviewAuthority({
      ...subject,
      repository: "EXAMPLE/PROJECT",
      actor: "REVIEWER",
      ...clock,
      repositoryPermission: permission("maintain", "write"),
    }).role,
    "maintainer",
  );
});

test("native managed-user and bot logins retain their complete identity", () => {
  for (const actor of ["mona-cat_octo", "reviewer[bot]", "a".repeat(39)]) {
    const repository = actor === "mona-cat_octo" ? `${actor}/project` : subject.repository;
    const observation = {
      ...permission("maintain", "write"),
      repository,
      actor,
      value: { role_name: "maintain", permission: "write", user: { login: actor } },
    };
    const result = resolveReviewAuthority({
      ...subject,
      repository,
      actor,
      ...clock,
      repositoryPermission: observation,
    });
    assert.equal(result.role, "maintainer");
    assert.equal(result.actor, actor);
    assert.equal(result.repository, repository);
    assert.equal(
      resolveReviewAuthority({
        ...subject,
        ...clock,
        repository: "other/project",
        actor,
        repositoryPermission: observation,
      }).reason,
      "subject_mismatch",
    );
  }
  assert.equal(
    resolveReviewAuthority({ ...subject, actor: "a".repeat(257), ...clock }).reason,
    "invalid_evidence",
  );
  for (const repository of [
    "owner /project",
    "owner/project/extra",
    `${"a".repeat(257)}/project`,
  ]) {
    assert.equal(
      resolveReviewAuthority({ ...subject, repository, ...clock }).reason,
      "invalid_evidence",
    );
  }
});

test("association and labels are not authority evidence", () => {
  const untrusted = { ...subject, ...clock, authorAssociation: "OWNER", labels: ["maintainer"] };
  assert.equal(resolveReviewAuthority(untrusted).role, "unknown");
});
