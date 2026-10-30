import type { ExactReviewQueueState } from "./exact-review-queue.ts";
import { exactReviewQueueIsPublication } from "./exact-review-decision.ts";
import { exactReviewParkedRecoveryAt } from "./exact-review-read-model.ts";
import { currentReviewFailure } from "./exact-review-observed-failure.ts";
import {
  normalizePublicReviewFailure,
  type PublicReviewFailure,
} from "../src/review-failure-explanation.ts";
import { publicTimestamp } from "./public-timestamp.ts";

export const WARNING_KINDS = [
  "scanner_refused",
  "review_retry_exhausted",
  "stale_revision",
] as const;
export const WARNING_SOURCE_LIMIT = 20;
export const WARNING_PUBLIC_LIMIT = 10;
export type WarningKind = (typeof WARNING_KINDS)[number];
export type ClaimObservation = { claimed_at: string; run_attempt: number | null };
export type WarningItem = {
  repository: string;
  item_number: number;
  item_kind: "issue" | "pull_request";
  revision: number | null;
  review_failure_attempts: number | null;
  observed_at: string | null;
  next_retry_at: string | null;
  failure: PublicReviewFailure | null;
};
export type RepeatedClaimItem = {
  repository: string;
  item_number: number;
  claims: number;
  first_claim_at: string;
  last_claim_at: string;
  recent_claims: ClaimObservation[];
};
export type WarningEvidence = {
  sample_limit: number;
  groups: { kind: WarningKind; total: number; items: WarningItem[] }[];
  repeated_claims: { total: number; items: RepeatedClaimItem[] } | null;
};

const iso = (value: number | undefined) =>
  Number.isFinite(value) && Number(value) > 0 && Number(value) <= 8_640_000_000_000_000
    ? new Date(Number(value)).toISOString()
    : null;

/** Internal candidate projection only. The Worker must revalidate public repository eligibility. */
export function exactReviewWarningEvidence(
  state: ExactReviewQueueState,
  staleRevisionKeys: ReadonlySet<string>,
  repeatedClaims: WarningEvidence["repeated_claims"],
): WarningEvidence {
  const groups = WARNING_KINDS.map((kind) => ({ kind, total: 0, items: [] as WarningItem[] }));
  // Keep only the newest bounded candidates per class without sorting the full queue.
  for (const item of Object.values(state.items)) {
    const publication = exactReviewQueueIsPublication(item);
    const kind = publication
      ? item.state === "pending" && staleRevisionKeys.has(item.key)
        ? "stale_revision"
        : null
      : item.state === "parked" &&
          (item.parkedReason === "scanner_refused" ||
            item.parkedReason === "review_retry_exhausted")
        ? item.parkedReason
        : null;
    const group = groups.find((group) => group.kind === kind);
    if (!group) continue;
    group.total += 1;
    const decision = item.decision;
    group.items.push({
      repository: decision.targetRepo.toLowerCase(),
      item_number: decision.itemNumber,
      item_kind: decision.itemKind,
      revision: item.revision,
      review_failure_attempts: item.reviewFailureAttempts ?? null,
      observed_at: iso(
        kind === "scanner_refused" ? item.scannerRefusal?.observedAt : item.updatedAt,
      ),
      // Do not project ordinary nextAttemptAt for parked or retained records.
      next_retry_at:
        kind === "review_retry_exhausted"
          ? iso(
              item.parkedRecoveryAt && exactReviewParkedRecoveryAt(item) !== null
                ? item.parkedRecoveryAt
                : undefined,
            )
          : null,
      failure: currentReviewFailure(item) ?? null,
    });
    group.items.sort(
      (a, b) =>
        (b.observed_at ?? "").localeCompare(a.observed_at ?? "") ||
        a.repository.localeCompare(b.repository) ||
        a.item_number - b.item_number ||
        (b.revision ?? 0) - (a.revision ?? 0),
    );
    if (group.items.length > WARNING_SOURCE_LIMIT) group.items.pop();
  }
  return { sample_limit: WARNING_SOURCE_LIMIT, groups, repeated_claims: repeatedClaims };
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const count = (value: unknown, max = 1_000_000): number | null =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max ? Number(value) : null;
const optionalCount = (value: unknown) => (value === null ? null : count(value));
const timestamp = (value: unknown) => (typeof value === "string" ? publicTimestamp(value) : null);
function target(source: Record<string, unknown>, allowed: ReadonlySet<string>) {
  const repository = source.repository;
  const number = count(source.item_number, 1_000_000_000);
  if (
    typeof repository !== "string" ||
    !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository) ||
    !allowed.has(repository) ||
    number === null ||
    number < 1
  )
    return null;
  return { repository, item_number: number };
}

/** Closed, optional, reprojectable public contract. Unknown fields and private identities never survive. */
export function publicWarningEvidence(
  value: unknown,
  allowed: ReadonlySet<string>,
): WarningEvidence | null {
  const source = object(value);
  if (
    !source ||
    ![WARNING_SOURCE_LIMIT, WARNING_PUBLIC_LIMIT].includes(Number(source.sample_limit)) ||
    !Array.isArray(source.groups) ||
    source.groups.length !== WARNING_KINDS.length
  )
    return null;
  const groups: WarningEvidence["groups"] = [];
  for (const kind of WARNING_KINDS) {
    const matches = source.groups.map(object).filter((group) => group?.kind === kind);
    const group = matches.length === 1 ? matches[0] : null;
    const total = count(group?.total);
    if (
      !group ||
      total === null ||
      !Array.isArray(group.items) ||
      group.items.length > WARNING_SOURCE_LIMIT ||
      group.items.length > total
    )
      return null;
    const items: WarningItem[] = [];
    for (const value of group.items) {
      const row = object(value);
      if (!row) continue;
      const reference = target(row, allowed);
      if (!reference || !["issue", "pull_request"].includes(String(row.item_kind))) continue;
      const revision = optionalCount(row.revision);
      const attempts = optionalCount(row.review_failure_attempts);
      const observed = timestamp(row.observed_at);
      const retry = timestamp(row.next_retry_at);
      if (
        (row.revision !== null && (revision === null || revision < 1)) ||
        (row.review_failure_attempts !== null && attempts === null) ||
        (row.observed_at !== null && observed === null) ||
        (row.next_retry_at !== null && retry === null) ||
        (kind !== "review_retry_exhausted" && retry !== null)
      )
        continue;
      const item: WarningItem = {
        ...reference,
        item_kind: row.item_kind as WarningItem["item_kind"],
        revision,
        review_failure_attempts: attempts,
        observed_at: observed,
        next_retry_at: retry,
        failure: normalizePublicReviewFailure(row.failure),
      };
      if (
        !items.some(
          (existing) =>
            existing.repository === item.repository &&
            existing.item_number === item.item_number &&
            existing.revision === item.revision,
        )
      )
        items.push(item);
      if (items.length === WARNING_PUBLIC_LIMIT) break;
    }
    groups.push({ kind, total, items });
  }
  let repeated: WarningEvidence["repeated_claims"] = null;
  const claims = object(source.repeated_claims);
  const total = count(claims?.total);
  if (
    claims &&
    total !== null &&
    Array.isArray(claims.items) &&
    claims.items.length <= WARNING_SOURCE_LIMIT &&
    claims.items.length <= total
  ) {
    const items: RepeatedClaimItem[] = [];
    for (const value of claims.items) {
      const row = object(value);
      if (!row) continue;
      const reference = target(row, allowed);
      const number = count(row.claims);
      const first = timestamp(row.first_claim_at),
        last = timestamp(row.last_claim_at);
      if (
        !reference ||
        !number ||
        !first ||
        !last ||
        first > last ||
        !Array.isArray(row.recent_claims) ||
        row.recent_claims.length > 5 ||
        row.recent_claims.length > number
      )
        continue;
      const recent: ClaimObservation[] = [];
      for (const value of row.recent_claims) {
        const entry = object(value);
        const at = timestamp(entry?.claimed_at),
          attempt = optionalCount(entry?.run_attempt);
        if (
          !entry ||
          !at ||
          at < first ||
          at > last ||
          (entry.run_attempt !== null && (!attempt || attempt < 1))
        )
          continue;
        recent.push({ claimed_at: at, run_attempt: attempt });
      }
      if (
        !items.some(
          (item) =>
            item.repository === reference.repository && item.item_number === reference.item_number,
        )
      )
        items.push({
          ...reference,
          claims: number,
          first_claim_at: first,
          last_claim_at: last,
          recent_claims: recent,
        });
      if (items.length === WARNING_PUBLIC_LIMIT) break;
    }
    repeated = { total, items };
  }
  return { sample_limit: WARNING_PUBLIC_LIMIT, groups, repeated_claims: repeated };
}
