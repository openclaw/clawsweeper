import { trailingHtmlComments } from "./review-comment-markers.js";

export const REVIEW_RECOVERY_STUCK_LABEL = "clawsweeper-recovery-stuck";
export const DEFAULT_REVIEW_RECOVERY_LABEL_MAX_CHECKS = 20;
export const DEFAULT_REVIEW_RECOVERY_LABEL_MAX_REMOVALS = 5;

const MAXIMUM_REVIEW_RECOVERY_LABEL_CHECKS = 100;
const MAXIMUM_REVIEW_RECOVERY_LABEL_REMOVALS = 20;
const MAXIMUM_SEARCH_RESULTS = 1_000;
const BACKFILL_PAGE_ROTATION_MS = 15 * 60 * 1_000;
const COMMENT_PAGE_SIZE = 100;
const MAXIMUM_COMMENT_PAGES = 3;
const TRUSTED_CLAWSWEEPER_BOT_LOGINS = new Set(["clawsweeper[bot]", "openclaw-clawsweeper[bot]"]);

type ReviewComment = {
  body?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  user?: { login?: unknown; type?: unknown } | null;
};

type ReviewRecoveryLabelBackfillOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: Date;
};

export type ReviewRecoveryLabelBackfillSummary = {
  checked: number;
  cleared: number;
  alreadyCleared: number;
  retained: number;
  errors: number;
  matched: number;
  remaining: number;
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

function boundedPositiveInteger(value: string | undefined, fallback: number, maximum: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

function isTrustedClawSweeperComment(comment: ReviewComment): boolean {
  const login = typeof comment.user?.login === "string" ? comment.user.login.toLowerCase() : "";
  const type = typeof comment.user?.type === "string" ? comment.user.type.toLowerCase() : "";
  return type === "bot" && TRUSTED_CLAWSWEEPER_BOT_LOGINS.has(login);
}

function commentActivityMs(comment: ReviewComment): number | null {
  const createdAt =
    typeof comment.created_at === "string" ? Date.parse(comment.created_at) : Number.NaN;
  const updatedAt =
    typeof comment.updated_at === "string" ? Date.parse(comment.updated_at) : Number.NaN;
  const activity = Math.max(
    Number.isFinite(createdAt) ? createdAt : Number.NEGATIVE_INFINITY,
    Number.isFinite(updatedAt) ? updatedAt : Number.NEGATIVE_INFINITY,
  );
  return Number.isFinite(activity) ? activity : null;
}

function markerItemNumber(marker: string): number | null {
  const match = marker.match(/\bitem=(\d+)(?=\s|-->)/i);
  if (!match?.[1]) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function markerReviewedAtMs(marker: string): number | null {
  const match = marker.match(/\breviewed_at=([^\s>]+)/i);
  if (!match?.[1]) return null;
  const reviewedAt = Date.parse(match[1]);
  return Number.isFinite(reviewedAt) ? reviewedAt : null;
}

function validHeadSha(value: unknown): string | null {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)) {
    return null;
  }
  return value.toLowerCase();
}

function markerHeadSha(marker: string): string | null {
  return validHeadSha(marker.match(/\bsha=([^\s>]+)/i)?.[1]);
}

function completedReviewActivityMs(
  number: number,
  comment: ReviewComment,
  markers: readonly string[],
  expectedHeadSha?: string,
): number | null {
  const canonicalMarker = markers.some(
    (marker) =>
      /^<!--\s*clawsweeper-review\s+item=\d+(?:\s+[^>]*)?\s*-->$/i.test(marker) &&
      markerItemNumber(marker) === number,
  );
  if (!canonicalMarker) return null;

  // Legacy started leases append the canonical review marker to a placeholder.
  // A stale review also has that marker, but neither is a completed publication.
  if (
    markers.some(
      (marker) =>
        /^<!--\s*clawsweeper-review-status:(?:started|stale)\b/i.test(marker) &&
        markerItemNumber(marker) === number,
    )
  ) {
    return null;
  }

  const versionMarker = markers.find(
    (marker) =>
      /^<!--\s*clawsweeper-review-version\b/i.test(marker) && markerItemNumber(marker) === number,
  );
  if (expectedHeadSha) {
    if (!versionMarker || markerHeadSha(versionMarker) !== expectedHeadSha) return null;
    return markerReviewedAtMs(versionMarker);
  }
  return (versionMarker ? markerReviewedAtMs(versionMarker) : null) ?? commentActivityMs(comment);
}

function completedReviewSupersedesPlaceholder(
  number: number,
  comments: readonly ReviewComment[],
  expectedHeadSha?: string,
): boolean {
  let latestCompletedReview = Number.NEGATIVE_INFINITY;
  let latestStartedPlaceholder = Number.NEGATIVE_INFINITY;

  for (const comment of comments) {
    if (!isTrustedClawSweeperComment(comment) || typeof comment.body !== "string") continue;
    const markers = trailingHtmlComments(comment.body);
    const hasStartedPlaceholder = markers.some(
      (marker) =>
        /^<!--\s*clawsweeper-review-status:started\b/i.test(marker) &&
        markerItemNumber(marker) === number,
    );
    if (hasStartedPlaceholder) {
      const activity = commentActivityMs(comment);
      // Missing timestamps cannot establish that a completed review superseded
      // this lease. Keep the escalation visible rather than guessing.
      if (activity === null) return false;
      latestStartedPlaceholder = Math.max(latestStartedPlaceholder, activity);
    }

    const completedAt = completedReviewActivityMs(number, comment, markers, expectedHeadSha);
    if (completedAt !== null) {
      latestCompletedReview = Math.max(latestCompletedReview, completedAt);
    }
  }

  return (
    Number.isFinite(latestCompletedReview) && latestCompletedReview >= latestStartedPlaceholder
  );
}

export async function runReviewRecoveryLabelBackfill(
  options: ReviewRecoveryLabelBackfillOptions = {},
): Promise<ReviewRecoveryLabelBackfillSummary> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date();
  const readToken = env.GH_TOKEN ?? env.GITHUB_TOKEN ?? "";
  const targetWriteToken = env.TARGET_WRITE_TOKEN ?? "";
  const repository = env.TARGET_REPO ?? "openclaw/openclaw";
  const apiUrl = (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const maximumChecks = boundedPositiveInteger(
    env.REVIEW_PLACEHOLDER_MAX_CHECKS,
    DEFAULT_REVIEW_RECOVERY_LABEL_MAX_CHECKS,
    MAXIMUM_REVIEW_RECOVERY_LABEL_CHECKS,
  );
  const maximumRemovals = boundedPositiveInteger(
    env.REVIEW_PLACEHOLDER_MAX_RECOVERIES,
    DEFAULT_REVIEW_RECOVERY_LABEL_MAX_REMOVALS,
    MAXIMUM_REVIEW_RECOVERY_LABEL_REMOVALS,
  );

  if (!readToken || !targetWriteToken || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(
      "review-recovery label backfill is misconfigured: missing read token, target write token, or valid target repository",
    );
  }

  const summary: ReviewRecoveryLabelBackfillSummary = {
    checked: 0,
    cleared: 0,
    alreadyCleared: 0,
    retained: 0,
    errors: 0,
    matched: 0,
    remaining: 0,
  };
  const github = async <T>(path: string): Promise<T> => {
    const response = await fetchImpl(`${apiUrl}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${readToken}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) throw new Error(`GET ${path} returned ${response.status}`);
    return (await response.json()) as T;
  };

  const query = `repo:${repository} is:open label:"${REVIEW_RECOVERY_STUCK_LABEL}"`;
  const searchPath = (page: number) =>
    `/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=asc&per_page=${maximumChecks}&page=${page}`;
  let search = await github<{ items?: unknown; total_count?: unknown }>(searchPath(1));
  const firstPageCandidates = Array.isArray(search.items) ? search.items : [];
  summary.matched =
    typeof search.total_count === "number" && Number.isFinite(search.total_count)
      ? Math.max(0, Math.trunc(search.total_count))
      : firstPageCandidates.length;
  // Truly stuck old items must not monopolize every 20-item sweep. Rotate
  // through GitHub's bounded 1,000-result search window without durable cursors
  // or new operator configuration; discovering total_count costs one request.
  const searchable = Math.min(summary.matched, MAXIMUM_SEARCH_RESULTS);
  const pageCount = Math.max(1, Math.ceil(searchable / maximumChecks));
  const page = (Math.floor(now.getTime() / BACKFILL_PAGE_ROTATION_MS) % pageCount) + 1;
  if (page !== 1) search = await github<{ items?: unknown }>(searchPath(page));
  const candidates = Array.isArray(search.items) ? search.items : [];
  const seen = new Set<number>();

  for (const candidate of candidates) {
    if (summary.checked >= maximumChecks || summary.cleared >= maximumRemovals) break;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const number = Number((candidate as { number?: unknown }).number);
    if (!Number.isSafeInteger(number) || number <= 0 || seen.has(number)) continue;
    seen.add(number);
    summary.checked += 1;

    try {
      const comments: ReviewComment[] = [];
      for (let page = 1; page <= MAXIMUM_COMMENT_PAGES; page += 1) {
        const pageComments = await github<ReviewComment[]>(
          `/repos/${repository}/issues/${number}/comments?sort=created&direction=desc&per_page=${COMMENT_PAGE_SIZE}&page=${page}`,
        );
        comments.push(...pageComments);
        if (pageComments.length < COMMENT_PAGE_SIZE) break;
      }

      let expectedHeadSha: string | undefined;
      if ((candidate as { pull_request?: unknown }).pull_request) {
        const pull = await github<{ head?: { sha?: unknown } }>(
          `/repos/${repository}/pulls/${number}`,
        );
        const currentHeadSha = validHeadSha(pull.head?.sha);
        if (!currentHeadSha) {
          summary.retained += 1;
          continue;
        }
        expectedHeadSha = currentHeadSha;
      }

      if (!completedReviewSupersedesPlaceholder(number, comments, expectedHeadSha)) {
        summary.retained += 1;
        continue;
      }

      const path = `/repos/${repository}/issues/${number}/labels/${encodeURIComponent(REVIEW_RECOVERY_STUCK_LABEL)}`;
      const response = await fetchImpl(`${apiUrl}${path}`, {
        method: "DELETE",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${targetWriteToken}`,
          "x-github-api-version": "2022-11-28",
        },
      });
      if (response.status === 404) {
        summary.alreadyCleared += 1;
        continue;
      }
      if (!response.ok) throw new Error(`DELETE ${path} returned ${response.status}`);

      summary.cleared += 1;
      console.log(`review-recovery label backfill: cleared resolved #${number}`);
    } catch (error) {
      summary.errors += 1;
      console.warn(
        `#${number} review-recovery label backfill skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  summary.remaining = Math.max(0, summary.matched - summary.checked);
  console.log(
    `review-recovery label backfill: checked=${summary.checked} cleared=${summary.cleared} already_cleared=${summary.alreadyCleared} retained=${summary.retained} errors=${summary.errors} matched=${summary.matched} remaining=${summary.remaining} at=${now.toISOString()}`,
  );
  return summary;
}
