import { asRecord } from "./value-coerce.js";

export type ReviewAuthoritySubject = { repository: string; actor: string };

// The acquisition owner supplies a fresh GET response and its requested subject.
// This envelope is provenance, not authentication of caller-supplied JSON.
export type ReviewAuthorityObservation = ReviewAuthoritySubject & {
  observedAt: string;
  value: unknown;
};

export type ReviewAuthority = ReviewAuthoritySubject & {
  role: "maintainer" | "ordinary" | "unknown";
  repositoryPermissionObservedAt: string | null;
  organizationMembershipObservedAt: string | null;
  reason:
    | "repository_role"
    | "organization_owner"
    | "unavailable"
    | "invalid_evidence"
    | "subject_mismatch"
    | "stale_evidence"
    | "contradictory_evidence"
    | "ambiguous_repository_role";
};

type RepositoryRole = "admin" | "maintain" | "write" | "triage" | "read" | "none";
type Evidence = { role: RepositoryRole | null; reason?: ReviewAuthority["reason"] };
const BASE_PERMISSION: Record<RepositoryRole, string> = {
  admin: "admin",
  maintain: "write",
  write: "write",
  triage: "read",
  read: "read",
  none: "none",
};
const PERMISSION_FLAGS = ["admin", "maintain", "push", "triage", "pull"] as const;
const FLAG_ROLES: RepositoryRole[] = ["admin", "maintain", "write", "triage", "read"];

function identity(value: unknown): string {
  return typeof value === "string" && value === value.trim() ? value.toLowerCase() : "";
}

// Native logins, including managed-user and bot suffixes, are opaque.
// Bound evidence and reject padding without imposing signup grammar.
function boundedIdentity(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && value.length <= 256 && value === value.trim();
}

function repositoryRole(value: unknown, actor: string): Evidence {
  const response = asRecord(value);
  const user = asRecord(response.user);
  if (identity(user.login) !== actor) return { role: null, reason: "subject_mismatch" };
  const permission = identity(response.permission);
  if (!["admin", "write", "read", "none"].includes(permission)) {
    return { role: null, reason: "invalid_evidence" };
  }
  const roleName = identity(response.role_name);
  if (response.role_name !== undefined && !roleName) {
    return { role: null, reason: "invalid_evidence" };
  }
  let role: RepositoryRole | null = Object.hasOwn(BASE_PERMISSION, roleName)
    ? (roleName as RepositoryRole)
    : null;
  if (role && BASE_PERMISSION[role] !== permission) {
    return { role: null, reason: "contradictory_evidence" };
  }

  if (user.permissions !== undefined) {
    const flags = asRecord(user.permissions);
    if (PERMISSION_FLAGS.some((flag) => typeof flags[flag] !== "boolean")) {
      return { role: null, reason: "invalid_evidence" };
    }
    const first = PERMISSION_FLAGS.findIndex((flag) => flags[flag] === true);
    if (first >= 0 && PERMISSION_FLAGS.slice(first).some((flag) => flags[flag] !== true)) {
      return { role: null, reason: "contradictory_evidence" };
    }
    const flagRole = first < 0 ? "none" : FLAG_ROLES[first]!;
    if (BASE_PERMISSION[flagRole] !== permission || (role && role !== flagRole)) {
      return { role: null, reason: "contradictory_evidence" };
    }
    role = flagRole;
  }

  // GitHub folds maintain into legacy "write". Custom or absent role names
  // need effective permission flags before write can distinguish either cohort.
  role ??= permission === "write" ? null : (permission as RepositoryRole);
  return role ? { role } : { role: null, reason: "ambiguous_repository_role" };
}

/** Inert classifier: no network, cache, admission, or mutation side effects. */
export function resolveReviewAuthority(
  options: ReviewAuthoritySubject & {
    now: number;
    maxAgeMs: number;
    repositoryPermission?: ReviewAuthorityObservation;
    organizationMembership?: ReviewAuthorityObservation;
  },
): ReviewAuthority {
  const repository = identity(options.repository);
  const actor = identity(options.actor);
  const [owner, name, ...extra] = repository.split("/");
  const result = (role: ReviewAuthority["role"], reason: ReviewAuthority["reason"]) => ({
    repository,
    actor,
    role,
    reason,
    repositoryPermissionObservedAt: options.repositoryPermission?.observedAt ?? null,
    organizationMembershipObservedAt: options.organizationMembership?.observedAt ?? null,
  });
  if (
    !boundedIdentity(owner) ||
    extra.length > 0 ||
    !/^[a-z0-9_.-]+$/.test(name ?? "") ||
    !boundedIdentity(actor) ||
    !Number.isFinite(options.now) ||
    !Number.isFinite(options.maxAgeMs) ||
    options.maxAgeMs < 0
  ) {
    return result("unknown", "invalid_evidence");
  }
  for (const observation of [options.repositoryPermission, options.organizationMembership]) {
    if (!observation) continue;
    if (identity(observation.repository) !== repository || identity(observation.actor) !== actor) {
      return result("unknown", "subject_mismatch");
    }
    const age = options.now - Date.parse(observation.observedAt);
    if (!Number.isFinite(age) || age < 0 || age > options.maxAgeMs) {
      return result("unknown", "stale_evidence");
    }
  }

  const evidence = options.repositoryPermission
    ? repositoryRole(options.repositoryPermission.value, actor)
    : null;
  if (evidence?.reason && evidence.reason !== "ambiguous_repository_role") {
    return result("unknown", evidence.reason);
  }
  let organizationOwner = false;
  if (options.organizationMembership) {
    const membership = asRecord(options.organizationMembership.value);
    if (
      identity(asRecord(membership.user).login) !== actor ||
      identity(asRecord(membership.organization).login) !== owner
    ) {
      return result("unknown", "subject_mismatch");
    }
    if (
      !["active", "pending"].includes(String(membership.state)) ||
      !["admin", "member"].includes(String(membership.role))
    ) {
      return result("unknown", "invalid_evidence");
    }
    organizationOwner = membership.state === "active" && membership.role === "admin";
  }
  if (organizationOwner) {
    // An active organization owner has repository admin access. Conflicting
    // snapshots need a new read; choosing the stronger one can retain revoked access.
    if (options.repositoryPermission && evidence?.role !== "admin") {
      return result("unknown", "contradictory_evidence");
    }
    return result("maintainer", "organization_owner");
  }
  if (!evidence) return result("unknown", "unavailable");
  if (!evidence.role) return result("unknown", "ambiguous_repository_role");
  return result(
    evidence.role === "admin" || evidence.role === "maintain" ? "maintainer" : "ordinary",
    "repository_role",
  );
}
