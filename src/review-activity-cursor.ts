import { createHash } from "node:crypto";
import { stableJson } from "./stable-json.js";

export const MAX_REVIEWED_PR_ACTIVITY = 1_000;
export const MAX_REVIEWED_PR_ACTIVITY_CURSOR_BYTES = 1024 * 1024;

const CURSOR_PATTERN = /^v2:([0-9]+):([0-9a-f]{64})$/;

export const REVIEWED_PR_ACTIVITY_THREADS_QUERY = `
  query ReviewedPrActivityThreads(
    $owner: String!
    $name: String!
    $number: Int!
    $after: String
  ) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            isResolved
          }
        }
      }
    }
  }
`;

export interface ReviewedPrActivityThreadsPage {
  threads: Array<{ id: string; isResolved: boolean }>;
  hasNextPage: boolean;
  endCursor: string | null;
}

export function createReviewedPrActivityCursor(options: {
  reviews: unknown[];
  inlineComments: unknown[];
  reviewThreads: unknown[];
}): string | null {
  if (
    options.reviews.length + options.inlineComments.length + options.reviewThreads.length >
    MAX_REVIEWED_PR_ACTIVITY
  ) {
    return null;
  }
  const entries = [
    ...options.reviews.map((review) => compactReviewActivity("review", review)),
    ...options.inlineComments.map((comment) => compactReviewActivity("inline_comment", comment)),
    ...options.reviewThreads.map(compactReviewThread),
  ].map((entry) => stableJson(entry));
  entries.sort((left, right) => left.localeCompare(right));
  const canonical = `[${entries.join(",")}]`;
  if (Buffer.byteLength(canonical, "utf8") > MAX_REVIEWED_PR_ACTIVITY_CURSOR_BYTES) return null;
  const digest = createHash("sha256").update(canonical).digest("hex");
  return `v2:${entries.length}:${digest}`;
}

export function isReviewedPrActivityCursor(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(CURSOR_PATTERN);
  if (!match) return false;
  const count = Number(match[1]);
  return Number.isSafeInteger(count) && count >= 0 && count <= MAX_REVIEWED_PR_ACTIVITY;
}

export function reviewedPrActivityThreadsPageFromGraphql(
  value: unknown,
): ReviewedPrActivityThreadsPage | null {
  const response = record(value);
  if (Array.isArray(response.errors) && response.errors.length > 0) return null;
  const data = record(response.data);
  const repository = record(data.repository);
  const pullRequest = record(repository.pullRequest);
  const connection = record(pullRequest.reviewThreads);
  const nodes = connection.nodes;
  const pageInfo = record(connection.pageInfo);
  if (!Array.isArray(nodes) || typeof pageInfo.hasNextPage !== "boolean") return null;
  const threads: ReviewedPrActivityThreadsPage["threads"] = [];
  for (const node of nodes) {
    const thread = record(node);
    if (
      typeof thread.id !== "string" ||
      thread.id.length === 0 ||
      typeof thread.isResolved !== "boolean"
    ) {
      return null;
    }
    threads.push({ id: thread.id, isResolved: thread.isResolved });
  }
  const endCursor = typeof pageInfo.endCursor === "string" ? pageInfo.endCursor : null;
  if (pageInfo.hasNextPage && !endCursor) return null;
  return {
    threads,
    hasNextPage: pageInfo.hasNextPage,
    endCursor,
  };
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
      body_sha256: digestScalar(activity.body),
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
    body_sha256: digestScalar(activity.body),
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

function compactReviewThread(value: unknown) {
  const thread = record(value);
  return {
    kind: "review_thread",
    id: scalar(thread.id),
    is_resolved: scalar(thread.isResolved ?? thread.is_resolved),
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

function digestScalar(value: unknown): string {
  return createHash("sha256").update(scalar(value)).digest("hex");
}
