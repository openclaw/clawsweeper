export type SchedulerItemKind = "issue" | "pull_request";

export interface SchedulerItem {
  repo: string;
  number: number;
  kind: SchedulerItemKind;
  createdAt: string;
  updatedAt: string;
  labels?: readonly string[] | undefined;
}

export interface SchedulerExistingReview {
  reviewedAt?: string | undefined;
  itemUpdatedAt?: string | undefined;
  automationItemUpdatedAt?: string | undefined;
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
  coverageTracked?: boolean | undefined;
}

const HOT_REVIEW_DAYS = 7;
const RECENT_ISSUE_DAYS = 30;
const HOURLY_REVIEW_MS = 60 * 60 * 1000;
// Hot-intake activity is eligible again after this existing hourly cadence. Keep
// exact-review suppression inside the same window so it only coalesces the
// immediate scheduled follow-up, rather than changing normal review cadence.
export const HOT_INTAKE_FRESHNESS_MS = HOURLY_REVIEW_MS;
const DAILY_REVIEW_DAYS = 1;
const WEEKLY_REVIEW_DAYS = 7;
export const WEEKLY_COVERAGE_REVIEW_DAYS = 6;
const DAY_MS = 24 * 60 * 60 * 1000;
const BULK_FILED_LABEL = "clawsweeper:bulk-filed";

function isBulkFiled(item: SchedulerItem): boolean {
  return item.labels?.some((label) => label.toLowerCase() === BULK_FILED_LABEL) ?? false;
}

function bulkFiledComparison(left: SchedulerDueCandidate, right: SchedulerDueCandidate): number {
  return Number(isBulkFiled(left.item)) - Number(isBulkFiled(right.item));
}

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
  // GitHub item timestamps have second-level precision. Comment and label
  // synchronization clocks therefore cannot prove ownership of later item
  // activity: an independent target update can share the same value. Keep
  // post-review activity eligible here and let the structural cache verify a
  // complete item receipt before suppressing the expensive review.
  if (review.itemUpdatedAt) {
    if (item.updatedAt === review.itemUpdatedAt) {
      return (
        Number.isFinite(updatedAt) &&
        reviewedAt !== null &&
        updatedAt === Math.floor(reviewedAt / 1000) * 1000
      );
    }
    return (
      Number.isFinite(updatedAt) &&
      reviewedAt !== null &&
      updatedAt >= Math.floor(reviewedAt / 1000) * 1000
    );
  }
  return (
    reviewedAt !== null &&
    Number.isFinite(updatedAt) &&
    updatedAt >= Math.floor(reviewedAt / 1000) * 1000
  );
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
  return (
    now - reviewedAt >=
    Math.min(reviewCadenceMs(item, review, now), WEEKLY_COVERAGE_REVIEW_DAYS * DAY_MS)
  );
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
  return (
    reviewedAt + Math.min(reviewCadenceMs(item, review, now), WEEKLY_COVERAGE_REVIEW_DAYS * DAY_MS)
  );
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
    bulkFiledComparison(left, right) ||
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
    bulkFiledComparison(left, right) ||
    left.nextDueAt - right.nextDueAt ||
    left.reviewedAt - right.reviewedAt ||
    left.priority - right.priority ||
    left.item.number - right.item.number
  );
}

function weeklyCoverageReferenceMs(candidate: SchedulerDueCandidate): number {
  if (candidate.reviewedAt > 0) {
    return candidate.reviewedAt;
  }
  const createdAt = Date.parse(candidate.item.createdAt);
  return Number.isFinite(createdAt) ? createdAt : 0;
}

function isCoverageUntracked(candidate: SchedulerDueCandidate): boolean {
  return (
    candidate.coverageTracked === false ||
    (candidate.coverageTracked === undefined && candidate.review === null)
  );
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

  const takeWeighted = (candidates: Array<SchedulerDueCandidate<ItemT, ReviewT>>): void => {
    const cohort = new Map<SchedulerBucket, Array<SchedulerDueCandidate<ItemT, ReviewT>>>();
    for (const [bucket] of SCHEDULER_BUCKET_WEIGHTS) cohort.set(bucket, []);
    for (const candidate of candidates) cohort.get(candidate.bucket)?.push(candidate);
    for (const bucketCandidates of cohort.values()) bucketCandidates.sort(compare);
    while (selected.length < capacity) {
      // Stop on candidates drained, not candidates selected. take() silently
      // drops an already-selected duplicate, so a pass that consumed only
      // duplicates is not evidence that the buckets are empty; measuring
      // selection here would strand every candidate queued behind them.
      let drained = 0;
      for (const [bucket, weight] of SCHEDULER_BUCKET_WEIGHTS) {
        const bucketCandidates = cohort.get(bucket);
        if (!bucketCandidates?.length) continue;
        for (
          let index = 0;
          index < weight && bucketCandidates.length && selected.length < capacity;
          index += 1
        ) {
          take(bucketCandidates.shift());
          drained += 1;
        }
      }
      if (drained === 0) break;
    }
  };

  // A legacy backfill report can be useful review context without satisfying
  // the canonical tuple coverage tracked by the Worker. Fill that operational
  // coverage gap before renewing already-canonical records.
  const coverageUntracked = due.filter(isCoverageUntracked);
  const untrackedCoverageDue = coverageUntracked
    .filter(
      (candidate) =>
        weeklyCoverageReferenceMs(candidate) + WEEKLY_COVERAGE_REVIEW_DAYS * DAY_MS <= now,
    )
    .sort(
      (left, right) =>
        bulkFiledComparison(left, right) ||
        weeklyCoverageReferenceMs(left) - weeklyCoverageReferenceMs(right) ||
        compare(left, right),
    );
  for (const candidate of untrackedCoverageDue) take(candidate);
  takeWeighted(
    coverageUntracked.filter(
      (candidate) =>
        !selectedKeys.has(schedulerItemKey(candidate.item.repo, candidate.item.number)),
    ),
  );

  // Weekly freshness remains the outer SLO for canonical records. Start the
  // coverage lane one day before the deadline, then select the oldest
  // last-review timestamps across every cadence bucket before hot-item churn.
  const weeklyCoverageDue = due
    .filter(
      (candidate) =>
        !isCoverageUntracked(candidate) &&
        weeklyCoverageReferenceMs(candidate) + WEEKLY_COVERAGE_REVIEW_DAYS * DAY_MS <= now,
    )
    .sort(
      (left, right) =>
        bulkFiledComparison(left, right) ||
        weeklyCoverageReferenceMs(left) - weeklyCoverageReferenceMs(right) ||
        compare(left, right),
    );
  for (const candidate of weeklyCoverageDue) take(candidate);
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
    // Stop on candidates drained, not candidates selected. GitHub's paginated
    // issue listing is sorted by `updated`, so an item touched mid-pagination
    // can appear on two pages; take() drops that duplicate silently. Measuring
    // selection here would read "hit a duplicate" as "buckets are drained" and
    // abandon every remaining candidate while capacity is still free.
    let drained = 0;
    for (const [bucket, weight] of SCHEDULER_BUCKET_WEIGHTS) {
      const candidates = buckets.get(bucket);
      if (!candidates?.length) continue;
      for (let i = 0; i < weight && candidates.length && selected.length < capacity; i += 1) {
        take(candidates.shift());
        drained += 1;
      }
    }
    if (drained === 0) break;
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
    bulkFiledComparison(left, right) ||
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
