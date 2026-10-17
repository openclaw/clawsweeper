const MAINTAINER_AUTHOR_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export function normalizeAuthorAssociation(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim().toUpperCase() : "NONE";
}

export function isMaintainerAuthorAssociation(value: unknown): boolean {
  return MAINTAINER_AUTHOR_ASSOCIATIONS.has(normalizeAuthorAssociation(value));
}

// GitHub shows a private org member to the App as CONTRIBUTOR. Repository
// permission is not hidden, so admin or maintain permission marks a maintainer.
const MAINTAINER_REPOSITORY_PERMISSIONS = new Set(["admin", "maintain"]);

export function isMaintainerRepositoryPermission(value: unknown): boolean {
  return (
    typeof value === "string" && MAINTAINER_REPOSITORY_PERMISSIONS.has(value.trim().toLowerCase())
  );
}

export function verifiedMaintainerAuthorAssociation(options: {
  authorAssociation: unknown;
  repositoryPermission: unknown;
}): string {
  const association = normalizeAuthorAssociation(options.authorAssociation);
  if (
    !isMaintainerAuthorAssociation(association) &&
    isMaintainerRepositoryPermission(options.repositoryPermission)
  ) {
    return "MEMBER";
  }
  return association;
}

type ReviewItem = {
  authorAssociation?: unknown;
  author_association?: unknown;
  labels?: unknown;
  createdAt?: unknown;
  created_at?: unknown;
};

// Maintainer items created from this moment are admitted like everyone else's:
// a PR gets one automatic review and later reviews need a request (#1997); an
// issue follows the ordinary issue cadence. Older maintainer items keep the
// request-only rule, so the change starts no backlog of first reviews. An
// unknown creation time keeps the request-only rule. The moment is when this
// rule first deployed (#2016). The queue releases a maintainer hold once its
// live check no longer requires a request, so items parked meanwhile recover.
export const MAINTAINER_AUTOMATIC_FIRST_REVIEW_FROM = "2026-10-15T03:50:00Z";
const MAINTAINER_AUTOMATIC_FIRST_REVIEW_FROM_MS = Date.parse(
  MAINTAINER_AUTOMATIC_FIRST_REVIEW_FROM,
);

export function predatesMaintainerAutomaticFirstReview(
  item: Pick<ReviewItem, "createdAt" | "created_at">,
): boolean {
  const value = item.createdAt ?? item.created_at;
  const createdAt = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return !(createdAt >= MAINTAINER_AUTOMATIC_FIRST_REVIEW_FROM_MS);
}

function reviewLabels(item: Pick<ReviewItem, "labels">): Set<string> {
  return new Set(
    (Array.isArray(item.labels) ? item.labels : []).map((label: unknown) => {
      const name =
        typeof label === "string"
          ? label
          : label && typeof label === "object" && "name" in label
            ? label.name
            : "";
      return typeof name === "string" ? name.trim().toLowerCase() : "";
    }),
  );
}

export function requiresMaintainerReviewRequest(item: ReviewItem): boolean {
  if (!predatesMaintainerAutomaticFirstReview(item)) {
    return false;
  }
  const labels = reviewLabels(item);
  return (
    labels.has("maintainer") ||
    isMaintainerAuthorAssociation(item.authorAssociation ?? item.author_association)
  );
}

export function isExplicitReviewRequest(decision: {
  sourceAction?: unknown;
  sourceCommentVerified?: unknown;
  sourceCommentId?: unknown;
  sourceCommentUpdatedAt?: unknown;
  commandBodyDigest?: unknown;
  commandOrigin?: unknown;
  commandStatusMarker?: unknown;
  statusCommentId?: unknown;
  publicationPolicy?: unknown;
}): boolean {
  if (decision.sourceAction === "manual_explicit_review") {
    return decision.publicationPolicy === "record_comment_only";
  }
  // Source-drift requeues copy the claimed decision. The queue keeps the
  // request's verification only when it requeues the request's own generation
  // in place, which also keeps the command status open; a requeue that finds no
  // queued item loses it. Such a verified retry continues that one request.
  // A later push or scheduled pass needs a new request.
  const continuesRequest =
    decision.sourceAction === "source_drift_requeue" &&
    Boolean(decision.commandStatusMarker || decision.statusCommentId);
  return (
    (decision.sourceAction === "re_review" || continuesRequest) &&
    decision.sourceCommentVerified === true &&
    Number.isSafeInteger(decision.sourceCommentId) &&
    Number(decision.sourceCommentId) > 0 &&
    typeof decision.sourceCommentUpdatedAt === "string" &&
    Number.isFinite(Date.parse(decision.sourceCommentUpdatedAt)) &&
    typeof decision.commandBodyDigest === "string" &&
    /^[0-9a-f]{64}$/.test(decision.commandBodyDigest) &&
    (decision.commandOrigin === "hosted_webhook" || decision.commandOrigin === "comment_router")
  );
}

export const MAINTAINER_REVIEW_REMINDER =
  "ClawSweeper reviews are opt-in for maintainers. If a review is required, finish the work and validation first, then comment `@clawsweeper review`. Please avoid repeated requests while a review is queued or running; agents should not request reviews automatically.";
