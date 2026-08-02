import { stringArg } from "./clawsweeper-args.js";
import {
  ALLOWED_REASONS,
  APPLY_PROTECTED_LABELS,
  AUTHOR_PR_BUDGET_MIN_AGE_DAYS,
  DAY_MS,
  OBSOLETE_FIX_PR_MIN_AGE_DAYS,
  PROTECTED_LABELS,
  STALE_VERSION_BUG_MIN_AGE_DAYS,
  UNCONFIRMED_PRODUCT_DIRECTION_MIN_AGE_DAYS,
  UNCONFIRMED_PRODUCT_DIRECTION_MIN_INACTIVE_DAYS,
  UNSPONSORED_FEATURE_MIN_AGE_DAYS,
} from "./clawsweeper-policy.js";
import type { ApplyKind, CloseReason, Item } from "./clawsweeper-types.js";

const MAINTAINER_AUTHOR_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

// Owners and members can legitimately file coordinated issue batches; outside
// collaborators still remain subject to bulk-filer policy.
const BULK_FILER_EXEMPT_AUTHOR_ASSOCIATIONS = new Set(["OWNER", "MEMBER"]);

// Installation tokens can redact membership to CONTRIBUTOR, so independently
// readable admin/maintain permissions provide the narrow fallback.
const BULK_FILER_EXEMPT_REPOSITORY_PERMISSIONS = new Set(["admin", "maintain"]);

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function login(value: unknown): string | undefined {
  const user = asRecord(value);
  const name = user.login;
  return typeof name === "string" ? name : undefined;
}

export function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((label) => {
      if (typeof label === "string") return label;
      const name = asRecord(label).name;
      return typeof name === "string" ? name : null;
    })
    .filter((name): name is string => Boolean(name));
}

export function normalizeAuthorAssociation(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim().toUpperCase() : "NONE";
}

export function isMaintainerAuthorAssociation(value: unknown): boolean {
  return MAINTAINER_AUTHOR_ASSOCIATIONS.has(normalizeAuthorAssociation(value));
}

export function isBulkFilerExemptAuthorAssociation(value: unknown): boolean {
  return BULK_FILER_EXEMPT_AUTHOR_ASSOCIATIONS.has(normalizeAuthorAssociation(value));
}

export function isBulkFilerExemptRepositoryPermission(value: unknown): boolean {
  return (
    typeof value === "string" &&
    BULK_FILER_EXEMPT_REPOSITORY_PERMISSIONS.has(value.trim().toLowerCase())
  );
}

export function isMaintainerAuthored(item: Pick<Item, "authorAssociation">): boolean {
  return isMaintainerAuthorAssociation(item.authorAssociation);
}

export function isVerifiedFixedCloseReason(reason: unknown): boolean {
  return reason === "implemented_on_main";
}

export function normalizeLabelName(label: string): string {
  return label.trim().toLowerCase();
}

export function protectedLabels(labels: readonly string[]): string[] {
  return labels
    .map((label) => normalizeLabelName(label))
    .filter(
      (label, index, normalized) =>
        PROTECTED_LABELS.has(label) && normalized.indexOf(label) === index,
    );
}

export function isProtectedItem(item: Pick<Item, "labels">): boolean {
  return protectedLabels(item.labels).length > 0;
}

export function applyBlockingProtectedLabels(
  labels: readonly string[],
  closeReason: unknown,
): string[] {
  const blocked = labels
    .map((label) => normalizeLabelName(label))
    .filter(
      (label, index, normalized) =>
        APPLY_PROTECTED_LABELS.has(label) && normalized.indexOf(label) === index,
    );
  if (!isVerifiedFixedCloseReason(closeReason)) return blocked;
  return blocked.filter((label) => label !== "maintainer");
}

export function applyProtectedLabelReason(labels: readonly string[], closeReason: unknown): string {
  return `protected label: ${applyBlockingProtectedLabels(labels, closeReason).join(", ")}`;
}

export function shouldPlanItem(item: Pick<Item, "authorAssociation" | "labels">): boolean {
  return protectedLabels(item.labels).every((label) => label === "maintainer");
}

export function isOlderThanDays(isoTimestamp: string, days: number, now = Date.now()): boolean {
  return isOlderThanMs(isoTimestamp, days * DAY_MS, now);
}

function isOlderThanMs(isoTimestamp: string, milliseconds: number, now = Date.now()): boolean {
  if (milliseconds <= 0) return true;
  const timestamp = Date.parse(isoTimestamp);
  if (!Number.isFinite(timestamp)) return false;
  return now - timestamp > milliseconds;
}

export function applyKindArg(value: string | boolean | string[] | undefined): ApplyKind {
  const kind = stringArg(value, "issue");
  if (kind === "issue" || kind === "pull_request" || kind === "all") return kind;
  throw new Error(`Invalid apply kind: ${kind}`);
}

export function closeReasonsArg(
  value: string | boolean | string[] | undefined,
): Set<CloseReason> | null {
  const raw = stringArg(value, "all").trim();
  if (!raw || raw === "all") return null;
  const reasons = new Set<CloseReason>();
  for (const part of raw.split(",")) {
    const reason = part.trim();
    if (!reason) continue;
    if (!ALLOWED_REASONS.has(reason as CloseReason)) {
      throw new Error(`Invalid apply close reason: ${reason}`);
    }
    reasons.add(reason as CloseReason);
  }
  return reasons.size ? reasons : null;
}

export function closeReasonFilterText(filter: ReadonlySet<CloseReason> | null): string {
  return filter ? [...filter].sort().join(",") : "all";
}

export function closeReasonEnabled(
  closeReason: CloseReason,
  filter: ReadonlySet<CloseReason> | null,
): boolean {
  return filter === null || filter.has(closeReason);
}

export function closeReasonApplyAgeSkipReason(
  item: Pick<Item, "createdAt">,
  closeReason: CloseReason,
  options: {
    minAgeMs: number;
    minAgeDescription: string;
    staleMinAgeDays: number;
    now?: number;
  },
): string | null {
  const now = options.now ?? Date.now();
  if (
    (closeReason === "stale_insufficient_info" || closeReason === "mostly_implemented_on_main") &&
    !isOlderThanDays(item.createdAt, options.staleMinAgeDays, now)
  ) {
    return `${closeReason} requires item older than ${options.staleMinAgeDays} days`;
  }
  if (!isOlderThanMs(item.createdAt, options.minAgeMs, now)) {
    return `created less than or equal to ${options.minAgeDescription} ago`;
  }
  return null;
}

export function unconfirmedProductDirectionAgeSkipReason(
  item: Pick<Item, "createdAt">,
  reviewedUpdatedAt: string | undefined,
  reviewedAt: string | undefined,
  now = Date.now(),
): string | null {
  if (!isOlderThanDays(item.createdAt, UNCONFIRMED_PRODUCT_DIRECTION_MIN_AGE_DAYS, now)) {
    return `unconfirmed_product_direction requires PR older than ${UNCONFIRMED_PRODUCT_DIRECTION_MIN_AGE_DAYS} days`;
  }
  const sourceUpdatedAtMs = Date.parse(reviewedUpdatedAt ?? "");
  const reviewedAtMs = Date.parse(reviewedAt ?? "");
  if (
    !Number.isFinite(sourceUpdatedAtMs) ||
    !Number.isFinite(reviewedAtMs) ||
    reviewedAtMs - sourceUpdatedAtMs <= UNCONFIRMED_PRODUCT_DIRECTION_MIN_INACTIVE_DAYS * DAY_MS
  ) {
    return `unconfirmed_product_direction requires ${UNCONFIRMED_PRODUCT_DIRECTION_MIN_INACTIVE_DAYS} days without source activity before review`;
  }
  return null;
}

export function unsponsoredFeatureAgeSkipReason(
  item: Pick<Item, "createdAt">,
  now = Date.now(),
): string | null {
  if (!isOlderThanDays(item.createdAt, UNSPONSORED_FEATURE_MIN_AGE_DAYS, now)) {
    return `unsponsored_feature_request requires issue older than ${UNSPONSORED_FEATURE_MIN_AGE_DAYS} days`;
  }
  return null;
}

export function authorPrBudgetAgeSkipReason(
  item: Pick<Item, "createdAt">,
  now = Date.now(),
): string | null {
  if (!isOlderThanDays(item.createdAt, AUTHOR_PR_BUDGET_MIN_AGE_DAYS, now)) {
    return `author_pr_budget_exceeded requires PR older than ${AUTHOR_PR_BUDGET_MIN_AGE_DAYS} days`;
  }
  return null;
}

export function staleVersionBugAgeSkipReason(
  item: Pick<Item, "createdAt">,
  now = Date.now(),
): string | null {
  if (!isOlderThanDays(item.createdAt, STALE_VERSION_BUG_MIN_AGE_DAYS, now)) {
    return `stale_version_bug requires issue older than ${STALE_VERSION_BUG_MIN_AGE_DAYS} days`;
  }
  return null;
}

export function obsoleteFixPrAgeSkipReason(
  item: Pick<Item, "createdAt">,
  now = Date.now(),
): string | null {
  if (!isOlderThanDays(item.createdAt, OBSOLETE_FIX_PR_MIN_AGE_DAYS, now)) {
    return `obsolete_fix_pr requires PR older than ${OBSOLETE_FIX_PR_MIN_AGE_DAYS} days`;
  }
  return null;
}
