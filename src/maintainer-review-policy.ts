const MAINTAINER_AUTHOR_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export function normalizeAuthorAssociation(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim().toUpperCase() : "NONE";
}

export function isMaintainerAuthorAssociation(value: unknown): boolean {
  return MAINTAINER_AUTHOR_ASSOCIATIONS.has(normalizeAuthorAssociation(value));
}

type ReviewItem = {
  authorAssociation?: unknown;
  author_association?: unknown;
  labels?: unknown;
};

export function requiresMaintainerReviewRequest(item: ReviewItem): boolean {
  const labels = new Set(
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
  if (labels.has("clawsweeper:autofix") || labels.has("clawsweeper:automerge")) return false;
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
