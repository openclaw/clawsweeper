export type SchedulerItemKind = "issue" | "pull_request";

export interface SchedulerItem {
  repo: string;
  number: number;
  kind: SchedulerItemKind;
  createdAt: string;
  updatedAt: string;
}

export interface SchedulerExistingReview {
  reviewedAt?: string | undefined;
  itemUpdatedAt?: string | undefined;
  reviewCommentSyncedAt?: string | undefined;
  labelsSyncedAt?: string | undefined;
  reviewStatus?: string | undefined;
  reviewPolicy?: string | undefined;
  decision?: string | undefined;
  contentDigest?: string | undefined;
  lastFullReviewAt?: string | undefined;
  lastFullReviewDecision?: string | undefined;
}

export type SchedulerBucket =
  | "hot_issue"
  | "hot_pull_request"
  | "activity"
  | "daily_pull_request"
  | "recent_issue"
  | "weekly_issue";

export interface SchedulerDueCandidate<
  ItemT extends SchedulerItem = SchedulerItem,
  ReviewT extends SchedulerExistingReview = SchedulerExistingReview,
> {
  item: ItemT;
  review: ReviewT | null;
  priority: number;
  reviewedAt: number;
  nextDueAt: number;
  bucket: SchedulerBucket;
}

const HOT_REVIEW_DAYS = 7;
const RECENT_ISSUE_DAYS = 30;
const HOURLY_REVIEW_MS = 60 * 60 * 1000;
const DAILY_REVIEW_DAYS = 1;
const WEEKLY_REVIEW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function timestampMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function schedulerItemKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

export function reviewedAtMs(review: SchedulerExistingReview | null): number | null {
  if (review?.reviewStatus !== "complete") return null;
  if (!review.reviewedAt) return null;
  const reviewedAt = Date.parse(review.reviewedAt);
  return Number.isFinite(reviewedAt) ? reviewedAt : null;
}

function hasActivitySinceReview(
  item: SchedulerItem,
  review: SchedulerExistingReview | null,
): boolean {
  if (!review) return false;
  const updatedAt = Date.parse(item.updatedAt);
  const reviewedAt = reviewedAtMs(review);
  const reviewCommentSyncedAt = timestampMs(review.reviewCommentSyncedAt);
  const labelsSyncedAt = timestampMs(review.labelsSyncedAt);
  const botOwnedSyncedAt = Math.max(
    reviewCommentSyncedAt ?? -Infinity,
    labelsSyncedAt ?? -Infinity,
  );
  if (review.itemUpdatedAt) {
    if (item.updatedAt === review.itemUpdatedAt) return false;
    if (Number.isFinite(updatedAt) && reviewedAt !== null && updatedAt <= reviewedAt) return false;
    if (
      Number.isFinite(updatedAt) &&
      Number.isFinite(botOwnedSyncedAt) &&
      updatedAt <= botOwnedSyncedAt
    ) {
      return false;
    }
    return true;
  }
  if (
    Number.isFinite(updatedAt) &&
    Number.isFinite(botOwnedSyncedAt) &&
    updatedAt <= botOwnedSyncedAt
  ) {
    return false;
  }
  return reviewedAt !== null && Number.isFinite(updatedAt) && updatedAt > reviewedAt;
}

function isCreatedWithinDays(
  item: Pick<SchedulerItem, "createdAt">,
  days: number,
  now = Date.now(),
): boolean {
  const createdAt = Date.parse(item.createdAt);
  return Number.isFinite(createdAt) && now - createdAt < days * DAY_MS;
}

function reviewCadenceMs(
  item: SchedulerItem,
  review: SchedulerExistingReview | null,
  now = Date.now(),
): number {
  if (hasActivitySinceReview(item, review)) return HOURLY_REVIEW_MS;
  if (isCreatedWithinDays(item, HOT_REVIEW_DAYS, now)) return DAILY_REVIEW_DAYS * DAY_MS;
  if (item.kind === "pull_request") return DAILY_REVIEW_DAYS * DAY_MS;
  const createdAt = Date.parse(item.createdAt);
  if (Number.isFinite(createdAt) && now - createdAt < RECENT_ISSUE_DAYS * DAY_MS) {
    return DAILY_REVIEW_DAYS * DAY_MS;
  }
  return WEEKLY_REVIEW_DAYS * DAY_MS;
}

export function hasReviewPolicyMismatch(
  review: SchedulerExistingReview | null,
  reviewPolicy?: string,
): boolean {
  return Boolean(review && reviewPolicy && review.reviewPolicy !== reviewPolicy);
}

export function shouldReviewItem(
  item: SchedulerItem,
  review: SchedulerExistingReview | null,
  now = Date.now(),
  reviewPolicy?: string,
): boolean {
  if (hasReviewPolicyMismatch(review, reviewPolicy)) return true;
  const reviewedAt = reviewedAtMs(review);
  if (reviewedAt === null) return true;
  return now - reviewedAt >= reviewCadenceMs(item, review, now);
}

export const REVIEW_CACHE_MAX_AGE_DAYS = 14;

export function reviewContentCacheHit(options: {
  review: SchedulerExistingReview | null;
  reviewPolicy: string | undefined;
  contentDigest: string;
  now?: number;
  explicitDispatch: boolean;
  maintainerRequest: boolean;
}): boolean {
  if (options.explicitDispatch || options.maintainerRequest) return false;
  const review = options.review;
  if (!review || review.reviewStatus !== "complete") return false;
  if (review.decision !== "keep_open") return false;
  if (review.lastFullReviewDecision !== "keep_open") return false;
  if (hasReviewPolicyMismatch(review, options.reviewPolicy)) return false;
  if (!review.contentDigest || review.contentDigest !== options.contentDigest) return false;
  const lastFullReviewAt = timestampMs(review.lastFullReviewAt);
  if (lastFullReviewAt === null) return false;
  const now = options.now ?? Date.now();
  return now - lastFullReviewAt < REVIEW_CACHE_MAX_AGE_DAYS * DAY_MS;
}

export function reviewPriority(
  item: SchedulerItem,
  review: SchedulerExistingReview | null,
  now = Date.now(),
  reviewPolicy?: string,
): number {
  if (isCreatedWithinDays(item, HOT_REVIEW_DAYS, now) && item.kind === "issue") return 0;
  if (isCreatedWithinDays(item, HOT_REVIEW_DAYS, now)) return 1;
  if (hasActivitySinceReview(item, review)) return 2;
  if (item.kind === "pull_request") return 3;
  const createdAt = Date.parse(item.createdAt);
  if (Number.isFinite(createdAt) && now - createdAt < RECENT_ISSUE_DAYS * DAY_MS) return 4;
  if (hasReviewPolicyMismatch(review, reviewPolicy)) return 5;
  return 6;
}

export function schedulerBucket(
  item: SchedulerItem,
  review: SchedulerExistingReview | null,
  now = Date.now(),
): SchedulerBucket {
  if (isCreatedWithinDays(item, HOT_REVIEW_DAYS, now)) {
    return item.kind === "issue" ? "hot_issue" : "hot_pull_request";
  }
  if (hasActivitySinceReview(item, review)) return "activity";
  if (item.kind === "pull_request") return "daily_pull_request";
  const createdAt = Date.parse(item.createdAt);
  if (Number.isFinite(createdAt) && now - createdAt < RECENT_ISSUE_DAYS * DAY_MS) {
    return "recent_issue";
  }
  return "weekly_issue";
}

export function nextReviewDueAtMs(
  item: SchedulerItem,
  review: SchedulerExistingReview | null,
  now = Date.now(),
  reviewPolicy?: string,
): number {
  if (hasReviewPolicyMismatch(review, reviewPolicy)) return 0;
  const reviewedAt = reviewedAtMs(review);
  if (reviewedAt === null) return 0;
  return reviewedAt + reviewCadenceMs(item, review, now);
}

export function compareDueCandidates<
  ItemT extends SchedulerItem,
  ReviewT extends SchedulerExistingReview,
>(
  left: SchedulerDueCandidate<ItemT, ReviewT>,
  right: SchedulerDueCandidate<ItemT, ReviewT>,
): number {
  return (
    left.priority - right.priority ||
    left.nextDueAt - right.nextDueAt ||
    left.reviewedAt - right.reviewedAt ||
    left.item.number - right.item.number
  );
}

function compareBackfillCandidates<
  ItemT extends SchedulerItem,
  ReviewT extends SchedulerExistingReview,
>(
  left: SchedulerDueCandidate<ItemT, ReviewT>,
  right: SchedulerDueCandidate<ItemT, ReviewT>,
): number {
  return (
    left.nextDueAt - right.nextDueAt ||
    left.reviewedAt - right.reviewedAt ||
    left.priority - right.priority ||
    left.item.number - right.item.number
  );
}

function weeklyReviewDeadlineMs(candidate: SchedulerDueCandidate): number {
  if (candidate.reviewedAt > 0) {
    return candidate.reviewedAt + WEEKLY_REVIEW_DAYS * DAY_MS;
  }
  const createdAt = Date.parse(candidate.item.createdAt);
  return Number.isFinite(createdAt) ? createdAt + WEEKLY_REVIEW_DAYS * DAY_MS : 0;
}

const SCHEDULER_BUCKET_WEIGHTS: ReadonlyArray<readonly [SchedulerBucket, number]> = [
  ["hot_issue", 4],
  ["hot_pull_request", 2],
  ["activity", 2],
  ["daily_pull_request", 3],
  ["recent_issue", 2],
  ["weekly_issue", 1],
];

export function selectDueCandidates<
  ItemT extends SchedulerItem,
  ReviewT extends SchedulerExistingReview,
>(
  due: Array<SchedulerDueCandidate<ItemT, ReviewT>>,
  limit: number,
  compare: (
    left: SchedulerDueCandidate<ItemT, ReviewT>,
    right: SchedulerDueCandidate<ItemT, ReviewT>,
  ) => number = compareDueCandidates,
  now = Date.now(),
): Array<SchedulerDueCandidate<ItemT, ReviewT>> {
  const capacity = Math.max(0, limit);
  if (capacity === 0) return [];
  const buckets = new Map<SchedulerBucket, Array<SchedulerDueCandidate<ItemT, ReviewT>>>();
  for (const [bucket] of SCHEDULER_BUCKET_WEIGHTS) buckets.set(bucket, []);
  for (const candidate of due) buckets.get(candidate.bucket)?.push(candidate);
  for (const candidates of buckets.values()) candidates.sort(compare);

  const selected: Array<SchedulerDueCandidate<ItemT, ReviewT>> = [];
  const selectedKeys = new Set<string>();
  const take = (candidate: SchedulerDueCandidate<ItemT, ReviewT> | undefined): void => {
    if (!candidate || selected.length >= capacity) return;
    const key = schedulerItemKey(candidate.item.repo, candidate.item.number);
    if (selectedKeys.has(key)) return;
    selectedKeys.add(key);
    selected.push(candidate);
  };

  // Weekly freshness is the outer SLO. Catch up breached items before applying
  // the normal weighted mix for hourly and daily work.
  const weeklyOverdue = due
    .filter((candidate) => weeklyReviewDeadlineMs(candidate) <= now)
    .sort(
      (left, right) =>
        weeklyReviewDeadlineMs(left) - weeklyReviewDeadlineMs(right) || compare(left, right),
    );
  for (const candidate of weeklyOverdue) take(candidate);
  for (const [bucket, candidates] of buckets) {
    buckets.set(
      bucket,
      candidates.filter(
        (candidate) =>
          !selectedKeys.has(schedulerItemKey(candidate.item.repo, candidate.item.number)),
      ),
    );
  }

  while (selected.length < capacity) {
    const before = selected.length;
    for (const [bucket, weight] of SCHEDULER_BUCKET_WEIGHTS) {
      const candidates = buckets.get(bucket);
      if (!candidates?.length) continue;
      for (let i = 0; i < weight && candidates.length && selected.length < capacity; i += 1) {
        take(candidates.shift());
      }
    }
    if (selected.length === before) break;
  }

  return selected;
}

export function appendFloorBackfillCandidates<
  ItemT extends SchedulerItem,
  ReviewT extends SchedulerExistingReview,
>(
  selected: Array<SchedulerDueCandidate<ItemT, ReviewT>>,
  backfill: Array<SchedulerDueCandidate<ItemT, ReviewT>>,
  options: { activeFloor: number; capacity: number },
): Array<SchedulerDueCandidate<ItemT, ReviewT>> {
  const activeFloor = Math.max(0, Math.floor(options.activeFloor));
  const capacity = Math.max(0, Math.floor(options.capacity));
  const target = Math.min(activeFloor, capacity);
  if (selected.length >= target) return selected;
  const selectedKeys = new Set(
    selected.map((candidate) => schedulerItemKey(candidate.item.repo, candidate.item.number)),
  );
  const filled = [...selected];
  for (const candidate of [...backfill].sort(compareBackfillCandidates)) {
    if (filled.length >= target) break;
    const key = schedulerItemKey(candidate.item.repo, candidate.item.number);
    if (selectedKeys.has(key)) continue;
    selectedKeys.add(key);
    filled.push(candidate);
  }
  return filled;
}

export function compareHotIntakeDueCandidates<
  ItemT extends SchedulerItem,
  ReviewT extends SchedulerExistingReview,
>(
  left: SchedulerDueCandidate<ItemT, ReviewT>,
  right: SchedulerDueCandidate<ItemT, ReviewT>,
): number {
  return (
    left.priority - right.priority ||
    hotIntakeRecencyMs(right.item) - hotIntakeRecencyMs(left.item) ||
    right.item.number - left.item.number
  );
}

export function hotIntakeRecencyMs(item: Pick<SchedulerItem, "createdAt" | "updatedAt">): number {
  const updatedAt = Date.parse(item.updatedAt);
  const createdAt = Date.parse(item.createdAt);
  return Math.max(
    Number.isFinite(updatedAt) ? updatedAt : 0,
    Number.isFinite(createdAt) ? createdAt : 0,
  );
}

export function shouldStopSaturatedPlanScan(options: {
  dueCount: number;
  capacity: number;
}): boolean {
  return options.capacity > 0 && options.dueCount >= options.capacity;
}
