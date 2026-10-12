import { trailingHtmlComments } from "./review-comment-markers.js";
import type { ReviewPlaceholderComment } from "./review-placeholder-recovery.js";

export const REVIEW_RECOVERY_STUCK_LABEL = "clawsweeper-recovery-stuck";

export type ReviewRecoveryLabelBackfillSummary = {
  checked: number;
  cleared: number;
  alreadyCleared: number;
  retained: number;
  errors: number;
  matched: number;
  remaining: number;
};

type ReviewRecoveryLabelBackfillOptions = {
  repository: string;
  now: Date;
  maximumChecks: number;
  maximumRecoveries: number;
  github: <T>(path: string) => Promise<T>;
  fetchComments: (
    number: number,
  ) => Promise<{ comments: ReviewPlaceholderComment[]; complete: boolean }>;
  removeLabel: (number: number) => Promise<"removed" | "missing">;
  isBotComment: (comment: ReviewPlaceholderComment) => boolean;
};

export function clearResolvedReviewRecoveryLabel(options: {
  number: number;
  labels: string[];
  complete: boolean;
  removeLabel: (number: number, label: string, onMutation?: () => void) => void;
  onMutation?: () => void;
}): boolean {
  if (!options.complete) return false;
  const index = options.labels.indexOf(REVIEW_RECOVERY_STUCK_LABEL);
  if (index < 0) return false;
  options.removeLabel(options.number, REVIEW_RECOVERY_STUCK_LABEL, options.onMutation);
  options.labels.splice(index, 1);
  return true;
}

function markerAttribute(marker: string, name: string): string | undefined {
  return marker.match(new RegExp(`\\b${name}=([^\\s>]+)`, "i"))?.[1];
}

function commentActivity(comment: ReviewPlaceholderComment): number {
  const times = [comment.created_at, comment.updated_at].map((value) =>
    typeof value === "string" ? Date.parse(value) : Number.NaN,
  );
  return Math.max(...times.filter(Number.isFinite));
}

function completedReviewSupersedesPlaceholder(
  number: number,
  comments: readonly ReviewPlaceholderComment[],
  isBotComment: ReviewRecoveryLabelBackfillOptions["isBotComment"],
  headSha?: string,
): boolean {
  let completedAt = Number.NEGATIVE_INFINITY;
  let startedAt = Number.NEGATIVE_INFINITY;
  let failedAt = Number.NEGATIVE_INFINITY;
  for (const comment of comments) {
    if (!isBotComment(comment) || typeof comment.body !== "string") continue;
    const markers = trailingHtmlComments(comment.body);
    const markerForItem = (marker: string, kind: string) =>
      new RegExp(`^<!--\\s*clawsweeper-${kind}\\b`, "i").test(marker) &&
      markerAttribute(marker, "item") === String(number);
    const started =
      markers.some((marker) => markerForItem(marker, "review-status:started")) ||
      /^ClawSweeper status:\s*review started\./i.test(comment.body.trimStart());
    if (started) {
      const activity = commentActivity(comment);
      if (!Number.isFinite(activity)) return false;
      startedAt = Math.max(startedAt, activity);
    }
    const canonical = markers.some(
      (marker) =>
        /^<!--\s*clawsweeper-review\s+item=\d+(?:\s+[^>]*)?\s*-->$/i.test(marker) &&
        markerAttribute(marker, "item") === String(number),
    );
    const failed =
      /^ClawSweeper review:\s*did not complete due to Codex infrastructure failure\./i.test(
        comment.body.trimStart(),
      );
    if (failed && canonical) {
      const version = markers.findLast((marker) => markerForItem(marker, "review-version"));
      const reviewedAt = version ? Date.parse(markerAttribute(version, "reviewed_at") ?? "") : NaN;
      const activity = Number.isFinite(reviewedAt) ? reviewedAt : commentActivity(comment);
      if (!Number.isFinite(activity)) return false;
      failedAt = Math.max(failedAt, activity);
    }
    if (
      started ||
      failed ||
      markers.some((marker) => markerForItem(marker, "review-status:stale")) ||
      !canonical
    ) {
      continue;
    }
    const version = markers.findLast((marker) => markerForItem(marker, "review-version"));
    if (version && markerAttribute(version, "v") !== "1") continue;
    const reviewedAt = version ? Date.parse(markerAttribute(version, "reviewed_at") ?? "") : NaN;
    if (
      headSha &&
      (!version ||
        !Number.isFinite(reviewedAt) ||
        markerAttribute(version, "sha")?.toLowerCase() !== headSha)
    ) {
      continue;
    }
    const activity = Number.isFinite(reviewedAt) ? reviewedAt : commentActivity(comment);
    if (Number.isFinite(activity)) completedAt = Math.max(completedAt, activity);
  }
  return Number.isFinite(completedAt) && completedAt >= startedAt && completedAt > failedAt;
}

export async function runReviewRecoveryLabelBackfill(
  options: ReviewRecoveryLabelBackfillOptions,
): Promise<ReviewRecoveryLabelBackfillSummary> {
  const { repository, now, maximumChecks, maximumRecoveries, github, fetchComments, removeLabel } =
    options;
  const summary: ReviewRecoveryLabelBackfillSummary = {
    checked: 0,
    cleared: 0,
    alreadyCleared: 0,
    retained: 0,
    errors: 0,
    matched: 0,
    remaining: 0,
  };
  const query = `repo:${repository} is:open label:"${REVIEW_RECOVERY_STUCK_LABEL}"`;
  const searchPath = (page: number) =>
    `/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=asc&per_page=${maximumChecks}&page=${page}`;
  type Search = { items?: unknown; total_count?: unknown };
  let search = await github<Search>(searchPath(1));
  const firstPage = Array.isArray(search.items) ? search.items : [];
  summary.matched =
    typeof search.total_count === "number" && Number.isFinite(search.total_count)
      ? Math.max(0, Math.trunc(search.total_count))
      : firstPage.length;
  const pages = Math.max(1, Math.ceil(Math.min(summary.matched, 1_000) / maximumChecks));
  const page = (Math.floor(now.getTime() / (15 * 60 * 1_000)) % pages) + 1;
  if (page !== 1) search = await github<Search>(searchPath(page));
  const seen = new Set<number>();
  for (const candidate of Array.isArray(search.items) ? search.items : []) {
    if (summary.checked >= maximumChecks || summary.cleared >= maximumRecoveries) break;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const number = Number((candidate as { number?: unknown }).number);
    if (!Number.isSafeInteger(number) || number <= 0 || seen.has(number)) continue;
    seen.add(number);
    summary.checked += 1;
    try {
      const { comments, complete } = await fetchComments(number);
      let headSha: string | undefined;
      if (complete && (candidate as { pull_request?: unknown }).pull_request) {
        const pull = await github<{ head?: { sha?: unknown } }>(
          `/repos/${repository}/pulls/${number}`,
        );
        const sha = pull.head?.sha;
        if (typeof sha === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)) {
          headSha = sha.toLowerCase();
        } else {
          summary.retained += 1;
          continue;
        }
      }
      if (
        !complete ||
        !completedReviewSupersedesPlaceholder(number, comments, options.isBotComment, headSha)
      ) {
        summary.retained += 1;
        continue;
      }
      if ((await removeLabel(number)) === "missing") summary.alreadyCleared += 1;
      else summary.cleared += 1;
    } catch (error) {
      summary.errors += 1;
      console.warn(
        `#${number} review-recovery label backfill skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  summary.remaining = Math.max(0, summary.matched - summary.checked);
  return summary;
}
