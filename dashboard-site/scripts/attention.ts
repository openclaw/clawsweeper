type AttentionItem = {
  repo: string;
  number: number;
  kind: string;
  reviewedAt: string | null;
  triagePriority?: string | null;
};

// Public, derived evidence only; never a certification of live GitHub status.
export type Assessment = {
  version: 1;
  lifecycle: "open_at_review" | "observed_open" | "historical" | "unknown";
  sourceValidity: "reviewed_snapshot" | "changed" | "unknown";
  reviewStatus: "complete" | "incomplete" | "unknown";
  reviewedAt: string | null;
  stateObservedAt: string | null;
  sourceObservedAt: string | null;
  reviewedHead: string | null;
  observedHead: string | null;
};

export type AttentionGroup = "open" | "changed" | "historical" | "unknown";

const digest = (value: unknown, length: number): string | null =>
  typeof value === "string" && new RegExp("^[a-f0-9]{" + length + "}$", "i").test(value)
    ? value.toLowerCase()
    : null;

// Match the corpus date guard, including its tolerance for producer clock skew.
const assessmentDate = (value: unknown, asOf: number): string | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time > Date.UTC(2020, 0, 2) && time <= asOf + 60_000
    ? new Date(time).toISOString()
    : null;
};

export function classifyAssessment(
  attrs: Readonly<Record<string, unknown>>,
  archived: boolean,
  asOf: number,
): Assessment {
  const reviewedAt = assessmentDate(attrs.reviewed_at, asOf);
  const reconciledAt = assessmentDate(attrs.reconciled_at, asOf);
  const reviewStatus =
    attrs.review_status === "complete" &&
    attrs.review_terminal_failure !== "true" &&
    attrs.review_terminal_failure !== true
      ? "complete"
      : typeof attrs.review_status === "string" && attrs.review_status !== "unknown"
        ? "incomplete"
        : "unknown";
  const reviewedHead = digest(attrs.pull_head_sha, 40);
  const observedHead = digest(attrs.current_pull_head_sha, 40);
  const snapshot = digest(attrs.item_snapshot_hash, 64);
  const observedSnapshot = digest(attrs.current_item_snapshot_hash, 64);
  const sourceRevision = digest(attrs.item_source_revision, 64);
  const drift =
    Boolean(reviewedHead && observedHead && reviewedHead !== observedHead) ||
    Boolean(snapshot && observedSnapshot && snapshot !== observedSnapshot) ||
    ["skipped_changed_since_review", "skipped_stale_head", "skipped_stale_revision"].includes(
      String(attrs.action_taken),
    ) ||
    attrs.review_status === "stale_reopened";
  const lifecycle =
    archived || attrs.current_state === "closed" || attrs.current_state === "merged"
      ? "historical"
      : attrs.current_state === "open" && reconciledAt
        ? "observed_open"
        : attrs.state_at_review === "open" && reviewedAt
          ? "open_at_review"
          : "unknown";
  // These are review-time identities, not an independently fetched matching
  // source. Equality/absence of drift fields and generic apply_checked_at
  // must never promote this to a current-source claim.
  const sourceValidity = drift
    ? "changed"
    : reviewStatus === "complete" &&
        reviewedAt &&
        snapshot &&
        sourceRevision &&
        (attrs.type !== "pull_request" || reviewedHead)
      ? "reviewed_snapshot"
      : "unknown";
  return {
    version: 1,
    lifecycle,
    sourceValidity,
    reviewStatus,
    reviewedAt,
    stateObservedAt:
      lifecycle === "observed_open" || lifecycle === "historical"
        ? reconciledAt
        : lifecycle === "open_at_review"
          ? reviewedAt
          : null,
    // apply_checked_at is also rewritten by unrelated skip paths. There is no
    // durable timestamp bound specifically to the recorded source comparison.
    sourceObservedAt: null,
    reviewedHead,
    observedHead,
  };
}

export function attentionGroup(assessment?: Assessment | null): AttentionGroup {
  if (assessment?.lifecycle === "historical") return "historical";
  if (assessment?.sourceValidity === "changed") return "changed";
  if (
    assessment?.reviewStatus === "complete" &&
    (assessment.lifecycle === "open_at_review" || assessment.lifecycle === "observed_open")
  )
    return "open";
  return "unknown";
}

export function reviewerPriority(value: unknown): string | null {
  return typeof value === "string" && /^P[0-3]$/.test(value) ? value : null;
}

export function compareAttention(a: AttentionItem, b: AttentionItem): number {
  const rank = (item: AttentionItem) =>
    Number(reviewerPriority(item.triagePriority)?.slice(1) ?? 4);
  return (
    rank(a) - rank(b) ||
    Number(!a.reviewedAt) - Number(!b.reviewedAt) ||
    (a.reviewedAt ?? "").localeCompare(b.reviewedAt ?? "") ||
    a.repo.localeCompare(b.repo) ||
    a.kind.localeCompare(b.kind) ||
    a.number - b.number
  );
}
