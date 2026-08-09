#!/usr/bin/env node
import { createHash, createHmac } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchDurableCursor,
  putDurableCursor,
  type DurableCursorSnapshot,
  type DurableCursorStoreOptions,
} from "./durable-cursor-store.js";
import {
  REVIEW_RECOVERY_STUCK_LABEL,
  runReviewRecoveryLabelBackfill,
} from "./review-recovery-label-backfill.js";

export const REVIEW_PLACEHOLDER_MARKER = "ClawSweeper status: review started.";
export const DEFAULT_REVIEW_PLACEHOLDER_MAX_CHECKS = 20;
export const DEFAULT_REVIEW_PLACEHOLDER_MIN_AGE_HOURS = 2;
export const DEFAULT_REVIEW_PLACEHOLDER_MAX_RECOVERIES = 5;
export const DEFAULT_REVIEW_PLACEHOLDER_STUCK_HOURS = 12;
export const REVIEW_PLACEHOLDER_STUCK_LABEL = REVIEW_RECOVERY_STUCK_LABEL;
export const DEFAULT_REVIEW_PLACEHOLDER_LOOKBACK_HOURS = 48;

const SEARCH_PAGE_SIZE = 100;
const SEARCH_RESULT_LIMIT = 1_000;
const COMMENT_PAGE_SIZE = 100;
const COMMENT_MAX_PAGES = 5;
const CLAWSWEEPER_BOT_LOGINS = new Set(["clawsweeper[bot]", "openclaw-clawsweeper[bot]"]);

export type ReviewPlaceholderComment = {
  body?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  id?: unknown;
  user?: { login?: unknown; type?: unknown } | null;
};

export type ReviewPlaceholderCandidate = {
  number?: unknown;
  pull_request?: unknown;
  labels?: unknown;
  updated_at?: unknown;
};

export type ReviewPlaceholderRecoverySummary = {
  checked: number;
  orphaned: number;
  enqueued: number;
  cleaned: number;
  escalated: number;
  errors: number;
  actionFailures: number;
  matched: number;
  remaining: number;
};

type ReviewPlaceholderState = "open" | "closed";
type ReviewPlaceholderCursorMode = `review-placeholder-${string}-${ReviewPlaceholderState}`;

export function reviewPlaceholderCursorMode(
  repository: string,
  state: ReviewPlaceholderState,
): ReviewPlaceholderCursorMode {
  const repositoryKey = createHash("sha256")
    .update(repository.toLowerCase())
    .digest("hex")
    .slice(0, 16);
  return `review-placeholder-${repositoryKey}-${state}`;
}

// The scheduled sweep should go red only when placeholders needed resolution
// and the run resolved none of them; routine transient noise with nothing to
// do must stay green or the 15-minute cadence turns into a standing alarm.
// Escalation labels are visibility, not resolution, so they never count.
export function reviewPlaceholderRecoveryFailureReason(
  summary: ReviewPlaceholderRecoverySummary,
): string | null {
  const resolved = summary.enqueued + summary.cleaned;
  if (summary.orphaned > 0 && summary.actionFailures > 0 && resolved === 0) {
    return "orphaned placeholders remain and every recovery action failed";
  }
  return null;
}

type ReviewPlaceholderRecoveryRunOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: Date;
  reconcileRecoveryLabels?: boolean;
};

function boundedPositiveInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

function commentCreatedAtMs(comment: ReviewPlaceholderComment): number | null {
  // A placeholder is refreshed in place when a new run re-claims the item, so
  // recent updated_at means active recovery, not orphaned state. Age from the
  // most recent activity, or a 15-min sweep would duplicate-enqueue items that
  // are already mid-review.
  const createdAtMs =
    typeof comment.created_at === "string" ? Date.parse(comment.created_at) : Number.NaN;
  const updatedAtMs =
    typeof comment.updated_at === "string" ? Date.parse(comment.updated_at) : Number.NaN;
  const latest = Math.max(
    Number.isFinite(createdAtMs) ? createdAtMs : Number.NEGATIVE_INFINITY,
    Number.isFinite(updatedAtMs) ? updatedAtMs : Number.NEGATIVE_INFINITY,
  );
  return Number.isFinite(latest) ? latest : null;
}

export function isClawSweeperBotComment(comment: ReviewPlaceholderComment): boolean {
  const login = typeof comment.user?.login === "string" ? comment.user.login.toLowerCase() : "";
  const type = typeof comment.user?.type === "string" ? comment.user.type.toLowerCase() : "";
  return type === "bot" && CLAWSWEEPER_BOT_LOGINS.has(login);
}

export function reviewStartStatusMarker(number: number): string {
  return `<!-- clawsweeper-review-status:started item=${number} `;
}

export function selectReviewPlaceholderComment(
  number: number,
  comments: readonly ReviewPlaceholderComment[],
): ReviewPlaceholderComment | null {
  const marker = reviewStartStatusMarker(number);
  const botComments = comments.filter(
    (comment) => isClawSweeperBotComment(comment) && typeof comment.body === "string",
  );
  const markerMatches = botComments.filter((comment) => String(comment.body).includes(marker));
  const pool =
    markerMatches.length > 0
      ? markerMatches
      : botComments.filter((comment) => String(comment.body).includes(REVIEW_PLACEHOLDER_MARKER));
  let latest: { comment: ReviewPlaceholderComment; createdAtMs: number } | null = null;
  for (const comment of pool) {
    const createdAtMs = commentCreatedAtMs(comment);
    if (createdAtMs === null) continue;
    if (!latest || createdAtMs > latest.createdAtMs) latest = { comment, createdAtMs };
  }
  return latest?.comment ?? null;
}

function candidateUpdatedAtMs(candidate: ReviewPlaceholderCandidate): number {
  const parsed =
    typeof candidate.updated_at === "string" ? Date.parse(candidate.updated_at) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function candidateNumber(candidate: ReviewPlaceholderCandidate): number {
  const number = Number(candidate.number);
  return Number.isSafeInteger(number) && number > 0 ? number : Number.MAX_SAFE_INTEGER;
}

function candidateLabelNames(candidate: ReviewPlaceholderCandidate): string[] {
  if (!Array.isArray(candidate.labels)) return [];
  const names: string[] = [];
  for (const label of candidate.labels) {
    if (typeof label === "string") names.push(label);
    else if (
      label &&
      typeof label === "object" &&
      typeof (label as { name?: unknown }).name === "string"
    ) {
      names.push((label as { name: string }).name);
    }
  }
  return names;
}

export function isOrphanedReviewPlaceholder(
  comment: ReviewPlaceholderComment | null,
  now: Date = new Date(),
  minimumAgeHours = DEFAULT_REVIEW_PLACEHOLDER_MIN_AGE_HOURS,
): boolean {
  if (!comment || !isClawSweeperBotComment(comment)) return false;
  if (typeof comment.body !== "string" || !comment.body.includes(REVIEW_PLACEHOLDER_MARKER)) {
    return false;
  }
  const createdAtMs = commentCreatedAtMs(comment);
  const minimumAgeMs = minimumAgeHours * 60 * 60 * 1_000;
  return (
    createdAtMs !== null &&
    Number.isFinite(minimumAgeMs) &&
    minimumAgeMs >= 0 &&
    now.getTime() - createdAtMs >= minimumAgeMs
  );
}

export async function runReviewPlaceholderRecovery(
  options: ReviewPlaceholderRecoveryRunOptions = {},
): Promise<ReviewPlaceholderRecoverySummary> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date();
  const token = env.GH_TOKEN ?? env.GITHUB_TOKEN ?? "";
  // Label mutations target the review repository, which the workflow-scoped
  // GITHUB_TOKEN cannot write to; escalation needs the app installation token.
  const targetWriteToken = env.TARGET_WRITE_TOKEN ?? "";
  const { CLAWSWEEPER_WEBHOOK_SECRET: webhookSecret = "" } = env;
  const repo = env.TARGET_REPO ?? "openclaw/openclaw";
  const targetBranch = env.TARGET_BRANCH ?? "main";
  const apiUrl = (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const queueUrl = (env.QUEUE_URL ?? "").replace(/\/$/, "");
  const cursorStoreUrl = (env.REVIEW_PLACEHOLDER_CURSOR_STORE_URL ?? "").replace(/\/$/, "");
  const maximumChecks = boundedPositiveInteger(
    env.REVIEW_PLACEHOLDER_MAX_CHECKS,
    DEFAULT_REVIEW_PLACEHOLDER_MAX_CHECKS,
    1_000,
  );
  const minimumAgeHours = boundedPositiveInteger(
    env.REVIEW_PLACEHOLDER_MIN_AGE_HOURS,
    DEFAULT_REVIEW_PLACEHOLDER_MIN_AGE_HOURS,
    24 * 30,
  );
  const maximumRecoveries = boundedPositiveInteger(
    env.REVIEW_PLACEHOLDER_MAX_RECOVERIES,
    DEFAULT_REVIEW_PLACEHOLDER_MAX_RECOVERIES,
    100,
  );
  const stuckAgeMs =
    boundedPositiveInteger(
      env.REVIEW_PLACEHOLDER_STUCK_HOURS,
      DEFAULT_REVIEW_PLACEHOLDER_STUCK_HOURS,
      24 * 30,
    ) *
    60 *
    60 *
    1_000;
  const lookbackHours = boundedPositiveInteger(
    env.REVIEW_PLACEHOLDER_LOOKBACK_HOURS,
    DEFAULT_REVIEW_PLACEHOLDER_LOOKBACK_HOURS,
    24 * 365,
  );
  let checked = 0;
  let orphaned = 0;
  let enqueued = 0;
  let cleaned = 0;
  let escalated = 0;
  let errors = 0;
  let actionFailures = 0;
  let matched = 0;

  const cursorStore = (
    state: ReviewPlaceholderState,
  ): DurableCursorStoreOptions<ReviewPlaceholderCursorMode> => ({
    baseUrl: cursorStoreUrl,
    webhookSecret,
    mode: reviewPlaceholderCursorMode(repo, state),
    fetchImpl,
  });

  const summary = (): ReviewPlaceholderRecoverySummary => {
    const remaining = Math.max(0, matched - checked);
    console.log(
      `review-placeholder recovery: checked=${checked} orphaned=${orphaned} enqueued=${enqueued} cleaned=${cleaned} escalated=${escalated} errors=${errors} action_failures=${actionFailures} matched=${matched} remaining=${remaining}`,
    );
    return {
      checked,
      orphaned,
      enqueued,
      cleaned,
      escalated,
      errors,
      actionFailures,
      matched,
      remaining,
    };
  };
  if (
    !token ||
    !webhookSecret ||
    !queueUrl ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
    !/^[A-Za-z0-9_./-]+$/.test(targetBranch)
  ) {
    // Silent no-op here means orphaned placeholders stay invisible forever;
    // in production every value comes from repo secrets/vars, so loss of one
    // is an operator problem the run must surface.
    throw new Error(
      "review-placeholder recovery is misconfigured: missing token, secret, or target",
    );
  }

  const github = async <T>(path: string): Promise<T> => {
    const response = await fetchImpl(`${apiUrl}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) throw new Error(`GET ${path} returned ${response.status}`);
    return (await response.json()) as T;
  };
  const enqueue = async (number: number, itemKind: "issue" | "pull_request"): Promise<void> => {
    const runIdentity = env.GITHUB_RUN_ID || String(now.getTime());
    const runAttempt = env.GITHUB_RUN_ATTEMPT || "1";
    const payload = {
      delivery_id: `router:review-placeholder-recovery-${runIdentity}-${runAttempt}-${number}`,
      decision: {
        targetRepo: repo,
        targetBranch,
        itemNumber: number,
        itemKind,
        sourceEvent: itemKind === "pull_request" ? "pull_request" : "issues",
        sourceAction: "review_placeholder_recovery",
        supersedesInProgress: false,
      },
    };
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`;
    const response = await fetchImpl(`${queueUrl}/internal/exact-review/enqueue`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawsweeper-exact-review-signature": signature,
      },
      body,
    });
    if (!response.ok) {
      throw new Error(`POST /internal/exact-review/enqueue returned ${response.status}`);
    }
    const acknowledgement = (await response.json().catch(() => null)) as {
      deduped?: unknown;
      queued?: unknown;
    } | null;
    if (acknowledgement?.queued !== true && acknowledgement?.deduped !== true) {
      throw new Error("POST /internal/exact-review/enqueue was not admitted");
    }
  };
  const mutateRecoveryLabel = async (
    number: number,
    label: string,
    method: "POST" | "DELETE",
  ): Promise<"removed" | "missing"> => {
    if (!targetWriteToken) {
      throw new Error("TARGET_WRITE_TOKEN is missing; cannot write labels on the target repo");
    }
    const path = `/repos/${repo}/issues/${number}/labels${
      method === "DELETE" ? `/${encodeURIComponent(label)}` : ""
    }`;
    const response = await fetchImpl(`${apiUrl}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${targetWriteToken}`,
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
        "x-github-api-version": "2022-11-28",
      },
      ...(method === "POST" ? { body: JSON.stringify({ labels: [label] }) } : {}),
    });
    if (method === "DELETE" && response.status === 404) return "missing";
    if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}`);
    return "removed";
  };
  const deletePlaceholderComment = async (
    number: number,
    commentId: number,
  ): Promise<"deleted" | "skipped"> => {
    if (!targetWriteToken) {
      throw new Error("TARGET_WRITE_TOKEN is missing; cannot delete placeholder comments");
    }
    // The closed state and placeholder body come from earlier snapshots; reread
    // both right before the destructive call so a reopened item or an in-flight
    // publish that edited the placeholder into a real review is not deleted.
    // The gate requires the machine status marker with this item's number, not
    // the human sentence, because a published review can quote the sentence.
    // GitHub has no conditional delete, so the one-RTT window between this
    // reread and the DELETE is an accepted residual race on a >=2h-orphaned
    // closed item; the durable review tuple in the state repo survives either
    // way and the 15-minute sweep converges.
    const item = await github<{ state?: unknown; locked?: unknown }>(
      `/repos/${repo}/issues/${number}`,
    );
    if (item.state !== "closed") return "skipped";
    const current = await github<ReviewPlaceholderComment>(
      `/repos/${repo}/issues/comments/${commentId}`,
    );
    if (
      !isClawSweeperBotComment(current) ||
      typeof current.body !== "string" ||
      !current.body.includes(reviewStartStatusMarker(number)) ||
      // A refresh bumps updated_at, so a placeholder re-claimed by an active
      // run drops back under the orphan age and must not be deleted.
      !isOrphanedReviewPlaceholder(current, now, minimumAgeHours)
    ) {
      return "skipped";
    }
    const response = await fetchImpl(`${apiUrl}/repos/${repo}/issues/comments/${commentId}`, {
      method: "DELETE",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${targetWriteToken}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) {
      // Observed live (openclaw/openclaw#99252): the installation token gets
      // 403 deleting comments in locked conversations even though it deletes
      // fine elsewhere; repo policy treats locked-comment 403s as terminal
      // skips, not errors to retry every sweep.
      if (response.status === 403 && item.locked === true) return "skipped";
      throw new Error(
        `DELETE /repos/${repo}/issues/comments/${commentId} returned ${response.status}`,
      );
    }
    return "deleted";
  };
  const fetchReviewComments = async (
    number: number,
    stopAtPlaceholder = false,
  ): Promise<{ comments: ReviewPlaceholderComment[]; complete: boolean }> => {
    const marker = reviewStartStatusMarker(number);
    const comments: ReviewPlaceholderComment[] = [];
    for (let page = 1; page <= COMMENT_MAX_PAGES; page += 1) {
      const pageComments = await github<ReviewPlaceholderComment[]>(
        `/repos/${repo}/issues/${number}/comments?sort=created&direction=desc&per_page=${COMMENT_PAGE_SIZE}&page=${page}`,
      );
      comments.push(...pageComments);
      if (pageComments.length < COMMENT_PAGE_SIZE) return { comments, complete: true };
      if (
        stopAtPlaceholder &&
        pageComments.some(
          (comment) => typeof comment.body === "string" && comment.body.includes(marker),
        )
      ) {
        return { comments, complete: false };
      }
    }
    return { comments, complete: false };
  };
  const fetchPlaceholderComment = async (
    number: number,
  ): Promise<ReviewPlaceholderComment | null> =>
    selectReviewPlaceholderComment(number, (await fetchReviewComments(number, true)).comments);

  const candidates = new Map<number, { candidate: ReviewPlaceholderCandidate; closed: boolean }>();
  const updatedSince = new Date(now.getTime() - lookbackHours * 60 * 60 * 1_000).toISOString();
  const cursors = new Map<
    ReviewPlaceholderState,
    DurableCursorSnapshot<ReviewPlaceholderCursorMode> & { loaded: boolean }
  >();
  const cursorUpdates = new Map<ReviewPlaceholderState, number>();
  for (const state of ["open", "closed"] as const) {
    if (!cursorStoreUrl) {
      cursors.set(state, {
        mode: reviewPlaceholderCursorMode(repo, state),
        nextCursor: 0,
        revision: 0,
        updatedAt: null,
        loaded: false,
      });
      continue;
    }
    try {
      cursors.set(state, { ...(await fetchDurableCursor(cursorStore(state))), loaded: true });
    } catch (error) {
      errors += 1;
      cursors.set(state, {
        mode: reviewPlaceholderCursorMode(repo, state),
        nextCursor: 0,
        revision: 0,
        updatedAt: null,
        loaded: false,
      });
      console.warn(
        `review-placeholder ${state} cursor unavailable; starting at 0 without advancing it: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Each state class gets its own check budget and durable offset. The cursor
  // advances through every examined search slot, not only actionable rows, so
  // a permanent false positive cannot pin later placeholders behind it.
  const searchCandidates = async (state: ReviewPlaceholderState): Promise<void> => {
    const query = `repo:${repo} "${REVIEW_PLACEHOLDER_MARKER}" in:comments updated:>=${updatedSince} is:${state}`;
    const cursor = cursors.get(state)!;
    const pages = new Map<number, { items: unknown[]; total: number; incomplete: boolean }>();
    const fetchPage = async (page: number) => {
      const cached = pages.get(page);
      if (cached) return cached;
      const result = await github<{
        items?: unknown;
        total_count?: unknown;
        incomplete_results?: unknown;
      }>(
        `/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=asc&per_page=${SEARCH_PAGE_SIZE}&page=${page}`,
      );
      const totalValue = Number(result.total_count);
      const items = Array.isArray(result.items) ? result.items : [];
      const value = {
        items,
        total: Number.isFinite(totalValue)
          ? Math.max(0, Math.trunc(totalValue), items.length)
          : items.length,
        incomplete: result.incomplete_results === true,
      };
      pages.set(page, value);
      return value;
    };

    let start = cursor.nextCursor < SEARCH_RESULT_LIMIT ? cursor.nextCursor : 0;
    let page = Math.floor(start / SEARCH_PAGE_SIZE) + 1;
    let result = await fetchPage(page);
    if (result.incomplete) throw new Error("GitHub returned incomplete search results");
    let telemetryTotal = Math.max(result.total, result.items.length);
    const pageOffset = start - (page - 1) * SEARCH_PAGE_SIZE;
    if (start > 0 && pageOffset >= result.items.length) {
      // Search counts lag comment mutations, so an empty/out-of-range page is
      // the completion signal. Reset from live page contents, never total_count.
      start = 0;
      page = 1;
      result = await fetchPage(page);
      if (result.incomplete) throw new Error("GitHub returned incomplete search results");
      telemetryTotal = Math.max(telemetryTotal, result.total, result.items.length);
    }
    matched += telemetryTotal;

    let remainingChecks = maximumChecks;
    let nextCursor = start;
    let reachedEnd = false;
    while (remainingChecks > 0 && page * SEARCH_PAGE_SIZE <= SEARCH_RESULT_LIMIT) {
      result = await fetchPage(page);
      if (result.incomplete) throw new Error("GitHub returned incomplete search results");
      const pageStart = (page - 1) * SEARCH_PAGE_SIZE;
      const from = page === Math.floor(start / SEARCH_PAGE_SIZE) + 1 ? start - pageStart : 0;
      const to = Math.min(result.items.length, from + remainingChecks);
      const ranked = result.items.map((value, index) => {
        const candidate =
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as ReviewPlaceholderCandidate)
            : null;
        return {
          candidate,
          index,
          number: candidate ? candidateNumber(candidate) : Number.MAX_SAFE_INTEGER,
          updatedAtMs: candidate ? candidateUpdatedAtMs(candidate) : Number.POSITIVE_INFINITY,
        };
      });
      ranked.sort(
        (a, b) => a.updatedAtMs - b.updatedAtMs || a.number - b.number || a.index - b.index,
      );
      for (const entry of ranked.slice(from, to)) {
        if (!entry.candidate || entry.number === Number.MAX_SAFE_INTEGER) continue;
        if (candidates.has(entry.number)) continue;
        candidates.set(entry.number, { candidate: entry.candidate, closed: state === "closed" });
      }
      const consumed = Math.max(0, to - from);
      remainingChecks -= consumed;
      nextCursor = pageStart + to;
      if (result.items.length < SEARCH_PAGE_SIZE) {
        reachedEnd = to >= result.items.length;
        break;
      }
      if (to < result.items.length) break;
      page += 1;
    }
    cursorUpdates.set(state, reachedEnd || nextCursor >= SEARCH_RESULT_LIMIT ? 0 : nextCursor);
  };
  for (const state of ["open", "closed"] as const) {
    try {
      await searchCandidates(state);
    } catch (error) {
      errors += 1;
      console.warn(
        `review-placeholder discovery (is:${state}) skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const orphanedCandidates: {
    number: number;
    itemKind: "issue" | "pull_request";
    createdAtMs: number;
  }[] = [];
  for (const [number, { candidate, closed }] of candidates) {
    checked += 1;
    try {
      const comment = await fetchPlaceholderComment(number);
      if (!comment || !isOrphanedReviewPlaceholder(comment, now, minimumAgeHours)) continue;
      orphaned += 1;
      if (closed) {
        // A closed item can never be recovered by re-enqueueing a review; the
        // only useful terminal action is removing the stale placeholder so the
        // thread stops claiming a review is in flight.
        const placeholderCommentId = Number(comment.id);
        try {
          if (!Number.isInteger(placeholderCommentId) || placeholderCommentId <= 0) {
            throw new Error("placeholder comment id is unavailable");
          }
          const outcome = await deletePlaceholderComment(number, placeholderCommentId);
          if (outcome === "deleted") {
            cleaned += 1;
            console.log(`review-placeholder recovery: cleaned closed #${number}`);
          } else {
            console.log(`review-placeholder recovery: skipped changed closed #${number}`);
          }
        } catch (cleanupError) {
          errors += 1;
          actionFailures += 1;
          console.warn(
            `#${number} closed-item placeholder cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
        }
        continue;
      }
      const itemKind = candidate.pull_request ? "pull_request" : "issue";
      const createdAtMs = commentCreatedAtMs(comment) ?? now.getTime();
      orphanedCandidates.push({ number, itemKind, createdAtMs });
      if (
        now.getTime() - createdAtMs >= stuckAgeMs &&
        !candidateLabelNames(candidate).includes(REVIEW_PLACEHOLDER_STUCK_LABEL)
      ) {
        try {
          await mutateRecoveryLabel(number, REVIEW_PLACEHOLDER_STUCK_LABEL, "POST");
          escalated += 1;
          console.error(
            `review-placeholder recovery: escalated #${number} as stuck after repeated orphan cycles`,
          );
        } catch (labelError) {
          errors += 1;
          console.warn(
            `#${number} review-placeholder stuck-label escalation failed: ${labelError instanceof Error ? labelError.message : String(labelError)}`,
          );
        }
      }
    } catch (error) {
      errors += 1;
      console.warn(
        `#${number} review-placeholder recovery skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  orphanedCandidates.sort((a, b) => a.createdAtMs - b.createdAtMs);
  for (const candidate of orphanedCandidates) {
    if (enqueued >= maximumRecoveries) break;
    try {
      await enqueue(candidate.number, candidate.itemKind);
      enqueued += 1;
      console.log(
        `review-placeholder recovery: enqueued #${candidate.number} (${candidate.itemKind})`,
      );
    } catch (error) {
      errors += 1;
      actionFailures += 1;
      console.warn(
        `#${candidate.number} review-placeholder recovery skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (options.reconcileRecoveryLabels && targetWriteToken) {
    try {
      const backfill = await runReviewRecoveryLabelBackfill({
        repository: repo,
        now,
        maximumChecks: Math.min(maximumChecks, 100),
        maximumRecoveries: Math.min(maximumRecoveries, 20),
        github,
        fetchComments: fetchReviewComments,
        removeLabel: (number) =>
          mutateRecoveryLabel(number, REVIEW_PLACEHOLDER_STUCK_LABEL, "DELETE"),
        isBotComment: isClawSweeperBotComment,
      });
      console.log(
        `review-recovery label reconciliation: checked=${backfill.checked} cleared=${backfill.cleared} retained=${backfill.retained} errors=${backfill.errors} matched=${backfill.matched} remaining=${backfill.remaining}`,
      );
    } catch (error) {
      console.warn(
        `review-recovery label reconciliation skipped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  if (cursorStoreUrl) {
    for (const state of ["open", "closed"] as const) {
      const cursor = cursors.get(state)!;
      const nextCursor = cursorUpdates.get(state);
      if (!cursor.loaded || nextCursor === undefined || nextCursor === cursor.nextCursor) continue;
      try {
        await putDurableCursor(cursorStore(state), nextCursor, cursor.revision);
        console.log(`review-placeholder ${state} cursor advanced to ${nextCursor}`);
      } catch (error) {
        errors += 1;
        console.warn(
          `review-placeholder ${state} cursor did not persist; attempted work remains idempotent: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return summary();
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const summary = await runReviewPlaceholderRecovery({ reconcileRecoveryLabels: true });
    const failureReason = reviewPlaceholderRecoveryFailureReason(summary);
    if (failureReason) {
      console.error(`review-placeholder recovery failed: ${failureReason}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(
      `review-placeholder recovery failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
