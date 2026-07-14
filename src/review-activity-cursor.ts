import { createHash } from "node:crypto";
import { stableJson } from "./stable-json.js";

export const MAX_REVIEWED_PR_ACTIVITY = 1_000;

const CURSOR_PATTERN = /^v1:([0-9]+):([0-9a-f]{64})$/;

export function createReviewedPrActivityCursor(options: {
  reviews: unknown[];
  inlineComments: unknown[];
}): string | null {
  if (options.reviews.length + options.inlineComments.length > MAX_REVIEWED_PR_ACTIVITY) {
    return null;
  }
  const entries = [
    ...options.reviews.map((review) => compactReviewActivity("review", review)),
    ...options.inlineComments.map((comment) => compactReviewActivity("inline_comment", comment)),
  ];
  entries.sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  const digest = createHash("sha256").update(stableJson(entries)).digest("hex");
  return `v1:${entries.length}:${digest}`;
}

export function isReviewedPrActivityCursor(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(CURSOR_PATTERN);
  if (!match) return false;
  const count = Number(match[1]);
  return Number.isSafeInteger(count) && count >= 0 && count <= MAX_REVIEWED_PR_ACTIVITY;
}

function compactReviewActivity(kind: "review" | "inline_comment", value: unknown) {
  const activity = record(value);
  const user = record(activity.user);
  if (kind === "review") {
    return {
      kind,
      id: scalar(activity.id),
      user: scalar(user.login),
      state: scalar(activity.state),
      body: scalar(activity.body),
      submitted_at: scalar(activity.submitted_at ?? activity.submittedAt),
      commit_id: scalar(activity.commit_id ?? activity.commitId),
    };
  }
  return {
    kind,
    id: scalar(activity.id),
    review_id: scalar(activity.pull_request_review_id),
    reply_to_id: scalar(activity.in_reply_to_id),
    user: scalar(user.login),
    body: scalar(activity.body),
    created_at: scalar(activity.created_at),
    updated_at: scalar(activity.updated_at ?? activity.created_at),
    path: scalar(activity.path),
    line: scalar(activity.line),
    side: scalar(activity.side),
    start_line: scalar(activity.start_line),
    start_side: scalar(activity.start_side),
    original_line: scalar(activity.original_line),
    original_commit_id: scalar(activity.original_commit_id),
    commit_id: scalar(activity.commit_id),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return stableJson(value);
}
