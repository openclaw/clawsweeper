import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const TRUSTED_AUTHORS = new Set(
  [
    "clawsweeper",
    "clawsweeper[bot]",
    "openclaw-clawsweeper[bot]",
    process.env.CLAWSWEEPER_COMMENT_AUTHOR_LOGIN?.toLowerCase(),
  ].filter((value): value is string => Boolean(value)),
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

function labelName(value: unknown): string {
  return scalar(object(value).name || value)
    .trim()
    .toLowerCase();
}

function ignorableOwnedLabel(label: string): boolean {
  if (label === "proof: override") return false;
  return (
    /^(?:status|rating|proof|merge-risk|impact|issue-rating):/.test(label) ||
    /^p[0-3]$/.test(label) ||
    label === "maturity:stable" ||
    (label.startsWith("clawsweeper:") &&
      !["clawsweeper:human-review", "clawsweeper:manual-only", "clawsweeper:bulk-filed"].includes(
        label,
      )) ||
    [
      "clawsweeper-recovery-stuck",
      "no-stale",
      "stale",
      "feature: ✨ showcase",
      "good first issue",
      "mantis: telegram-visible-proof",
      "triage: needs-real-behavior-proof",
    ].includes(label)
  );
}

function trustedClawSweeperComment(comment: JsonObject): boolean {
  return TRUSTED_AUTHORS.has(login(comment.user) || scalar(comment.author).trim().toLowerCase());
}

export function scheduledReviewSemanticSourceRevision(
  issue: unknown,
  comments: readonly unknown[],
): string {
  const source = object(issue);
  const snapshot = {
    title: scalar(source.title),
    body: scalar(source.body),
    labels: (Array.isArray(source.labels) ? source.labels : [])
      .map(labelName)
      .filter(Boolean)
      .filter((label) => !ignorableOwnedLabel(label))
      .sort(),
    comments: comments
      .map(object)
      .filter((comment) => !trustedClawSweeperComment(comment))
      .map((comment) => ({
        id: scalar(comment.id),
        author: scalar(login(comment.user) || comment.author),
        body: scalar(comment.body),
        updated_at: scalar(comment.updated_at ?? comment.updatedAt ?? comment.created_at),
      }))
      .sort((left, right) =>
        `${left.id}:${left.updated_at}`.localeCompare(`${right.id}:${right.updated_at}`),
      ),
  };
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
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
  const liveRevision = scheduledReviewSemanticSourceRevision(issue, options.comments);
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
      return { noop: true, reason: "trusted_owned_activity_only" };
    }
  }
  return { noop: false, reason: "missing_or_changed_durable_source" };
}

function run(): void {
  const result = classifyScheduledReviewNoop({
    decision: JSON.parse(process.env.CLAIM_DECISION || "{}"),
    issue: JSON.parse(process.env.LIVE_ITEM || "{}"),
    comments: JSON.parse(process.env.LIVE_COMMENTS || "[]"),
    liveHeadSha: process.env.LIVE_HEAD_SHA,
  });
  const output = `scheduled_noop=${result.noop}\nscheduled_noop_reason=${result.reason}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  else process.stdout.write(output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
