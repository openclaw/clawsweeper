#!/usr/bin/env node
import { createHmac } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REVIEW_PLACEHOLDER_MARKER = "ClawSweeper status: review started.";
export const DEFAULT_REVIEW_PLACEHOLDER_MAX_CHECKS = 20;
export const DEFAULT_REVIEW_PLACEHOLDER_MIN_AGE_HOURS = 2;
export const DEFAULT_REVIEW_PLACEHOLDER_MAX_RECOVERIES = 5;
export const REVIEW_PLACEHOLDER_LOOKBACK_HOURS = 48;

const SEARCH_PAGE_SIZE = 100;
const SEARCH_MAX_PAGES = 2;
const COMMENT_PAGE_SIZE = 100;
const COMMENT_MAX_PAGES = 2;
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
};

export type ReviewPlaceholderRecoverySummary = {
  checked: number;
  orphaned: number;
  enqueued: number;
  errors: number;
};

type ReviewPlaceholderRecoveryRunOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: Date;
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

export function latestClawSweeperBotComment(
  comments: readonly ReviewPlaceholderComment[],
): ReviewPlaceholderComment | null {
  let latest: { comment: ReviewPlaceholderComment; createdAtMs: number } | null = null;
  for (const comment of comments) {
    if (!isClawSweeperBotComment(comment)) continue;
    const createdAtMs = commentCreatedAtMs(comment);
    if (createdAtMs === null) continue;
    if (!latest || createdAtMs > latest.createdAtMs) latest = { comment, createdAtMs };
  }
  return latest?.comment ?? null;
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
  const { CLAWSWEEPER_WEBHOOK_SECRET: webhookSecret = "" } = env;
  const repo = env.TARGET_REPO ?? "openclaw/openclaw";
  const targetBranch = env.TARGET_BRANCH ?? "main";
  const apiUrl = (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const queueUrl = (env.QUEUE_URL ?? "").replace(/\/$/, "");
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
  let checked = 0;
  let orphaned = 0;
  let enqueued = 0;
  let errors = 0;

  const summary = (): ReviewPlaceholderRecoverySummary => {
    console.log(
      `review-placeholder recovery: checked=${checked} orphaned=${orphaned} enqueued=${enqueued} errors=${errors}`,
    );
    return { checked, orphaned, enqueued, errors };
  };
  if (
    !token ||
    !webhookSecret ||
    !queueUrl ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
    !/^[A-Za-z0-9_./-]+$/.test(targetBranch)
  ) {
    console.warn("review-placeholder recovery skipped: missing or invalid configuration");
    return summary();
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
  const fetchLatestBotComment = async (
    number: number,
  ): Promise<ReviewPlaceholderComment | null> => {
    const comments: ReviewPlaceholderComment[] = [];
    for (let page = 1; page <= COMMENT_MAX_PAGES; page += 1) {
      const pageComments = await github<ReviewPlaceholderComment[]>(
        `/repos/${repo}/issues/${number}/comments?sort=created&direction=desc&per_page=${COMMENT_PAGE_SIZE}&page=${page}`,
      );
      comments.push(...pageComments);
      if (pageComments.length < COMMENT_PAGE_SIZE) break;
    }
    return latestClawSweeperBotComment(comments);
  };

  const candidates = new Map<number, ReviewPlaceholderCandidate>();
  const updatedSince = new Date(
    now.getTime() - REVIEW_PLACEHOLDER_LOOKBACK_HOURS * 60 * 60 * 1_000,
  ).toISOString();
  const query = `repo:${repo} "${REVIEW_PLACEHOLDER_MARKER}" in:comments updated:>=${updatedSince} is:open`;
  for (let page = 1; page <= SEARCH_MAX_PAGES && candidates.size < maximumChecks; page += 1) {
    try {
      const result = await github<{ items?: unknown }>(
        `/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=${SEARCH_PAGE_SIZE}&page=${page}`,
      );
      const items = Array.isArray(result.items) ? result.items : [];
      for (const value of items) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const candidate = value as ReviewPlaceholderCandidate;
        const number = Number(candidate.number);
        if (!Number.isInteger(number) || number <= 0 || candidates.has(number)) continue;
        candidates.set(number, candidate);
        if (candidates.size >= maximumChecks) break;
      }
      if (items.length < SEARCH_PAGE_SIZE) break;
    } catch (error) {
      errors += 1;
      console.warn(
        `review-placeholder discovery page ${page} skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      break;
    }
  }

  for (const [number, candidate] of candidates) {
    if (enqueued >= maximumRecoveries) break;
    checked += 1;
    try {
      const comment = await fetchLatestBotComment(number);
      if (!isOrphanedReviewPlaceholder(comment, now, minimumAgeHours)) continue;
      orphaned += 1;
      const itemKind = candidate.pull_request ? "pull_request" : "issue";
      await enqueue(number, itemKind);
      enqueued += 1;
      console.log(`review-placeholder recovery: enqueued #${number} (${itemKind})`);
    } catch (error) {
      errors += 1;
      console.warn(
        `#${number} review-placeholder recovery skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return summary();
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  await runReviewPlaceholderRecovery().catch((error) => {
    console.warn(
      `review-placeholder recovery skipped after unexpected error: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}
