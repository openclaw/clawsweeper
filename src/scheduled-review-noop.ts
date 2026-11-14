import { CLAWSWEEPER_BOT_LOGINS } from "./clawsweeper-bot-identity.ts";
import { itemSourceRevisionSha256 } from "./clawsweeper-source-revision.ts";

const TRUSTED_AUTHORS = new Set(
  [...CLAWSWEEPER_BOT_LOGINS, process.env.CLAWSWEEPER_COMMENT_AUTHOR_LOGIN?.toLowerCase()].filter(
    (value): value is string => Boolean(value),
  ),
);
const SOURCE_REVISION_PATTERN =
  /<!--\s+clawsweeper-review-version\b[^>]*\bsource_revision=([0-9a-f]{64})\b[^>]*-->/g;
const REVIEWED_SHA_PATTERN = /<!--\s+clawsweeper-review-version\b[^>]*\bsha=([^\s>]+)\b[^>]*-->/g;
const SETTLING_WINDOW_MS = 30_000;
type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function login(value: unknown): string {
  return scalar(object(value).login).trim().toLowerCase();
}

function trustedClawSweeperComment(comment: JsonObject): boolean {
  return TRUSTED_AUTHORS.has(login(comment.user) || scalar(comment.author).trim().toLowerCase());
}

function durableSourceRevision(body: string): string | null {
  let revision: string | null = null;
  for (const match of body.matchAll(SOURCE_REVISION_PATTERN)) revision = match[1] ?? null;
  return revision;
}

function durableReviewedSha(body: string): string | null {
  let sha: string | null = null;
  for (const match of body.matchAll(REVIEWED_SHA_PATTERN)) sha = match[1] ?? null;
  return sha;
}

export function classifyScheduledReviewNoop(options: {
  decision: unknown;
  issue: unknown;
  comments: readonly unknown[];
  liveHeadSha?: string;
}): { noop: boolean; reason: string } {
  const decision = object(options.decision);
  const issue = object(options.issue);
  if (decision.sourceAction !== "scheduled_hot_intake") {
    return { noop: false, reason: "not_scheduled_hot" };
  }
  if (issue.state !== "open" || issue.locked === true) {
    return { noop: false, reason: "live_state_requires_guard" };
  }
  const queuedUpdatedAt = Date.parse(scalar(decision.sourceUpdatedAt));
  const liveUpdatedAt = Date.parse(scalar(issue.updated_at));
  if (!Number.isFinite(queuedUpdatedAt) || queuedUpdatedAt !== liveUpdatedAt) {
    return { noop: false, reason: "queued_source_drift" };
  }
  return trustedOwnedActivityOnly({ ...options, issue })
    ? { noop: true, reason: "trusted_owned_activity_only" }
    : { noop: false, reason: "missing_or_changed_durable_source" };
}

/**
 * True when the item's latest activity is ClawSweeper's own review write: its
 * durable review comment records the current semantic source and settled
 * within moments of the item's updated_at. Scheduling and admission share it.
 */
export function trustedOwnedActivityOnly(options: {
  issue: unknown;
  comments: readonly unknown[];
  liveHeadSha?: string;
}): boolean {
  const issue = object(options.issue);
  const liveUpdatedAt = Date.parse(scalar(issue.updated_at));
  if (!Number.isFinite(liveUpdatedAt)) return false;
  // The writer's own revision function, so the recorded and live revisions cannot drift.
  const liveRevision = itemSourceRevisionSha256(issue, [...options.comments]);
  for (const comment of [...options.comments].map(object).reverse()) {
    if (!trustedClawSweeperComment(comment)) continue;
    const recordedRevision = durableSourceRevision(scalar(comment.body));
    const recordedSha = durableReviewedSha(scalar(comment.body));
    const commentUpdatedAt = Date.parse(scalar(comment.updated_at ?? comment.created_at));
    if (
      recordedRevision === liveRevision &&
      (!issue.pull_request ||
        (Boolean(options.liveHeadSha) && recordedSha === options.liveHeadSha)) &&
      Number.isFinite(commentUpdatedAt) &&
      liveUpdatedAt >= commentUpdatedAt &&
      liveUpdatedAt - commentUpdatedAt <= SETTLING_WINDOW_MS
    ) {
      return true;
    }
  }
  return false;
}
