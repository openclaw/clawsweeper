import { recordOrEmpty as record } from "./value-coerce.js";
import { createHash } from "node:crypto";

import { stableJsonCodeUnit } from "./stable-json.js";

export const MAX_REVIEWED_PR_ACTIVITY = 1_000;
export const MAX_REVIEWED_PR_ACTIVITY_CURSOR_BYTES = 1024 * 1024;
export const MAX_REVIEWED_PR_ACTIVITY_BATCH_SIZE = 8;
export const REVIEWED_PR_ACTIVITY_V2_CONNECTION_LIMIT = 100;

const CURSOR_PATTERN = /^v([12]):([0-9]+):([0-9a-f]{64})$/;

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

export interface ReviewedPrActivityCursorV2Batch {
  cursors: Record<string, string | null>;
  failures: Record<string, string>;
}

export type ReviewedPrActivityCursorComparison = "equal" | "changed" | "rebaseline";

export class ReviewedPrActivityChangedDuringReadError extends Error {
  constructor() {
    super("pull request review activity changed while refreshing the bounded cursor");
    this.name = "ReviewedPrActivityChangedDuringReadError";
  }
}

export function createReviewedPrActivityCursor(options: {
  reviews: unknown[];
  inlineComments: unknown[];
  reviewThreads: unknown[];
}): string | null {
  return createVersionedReviewedPrActivityCursor("v1", options);
}

export function createReviewedPrActivityCursorV2(options: {
  reviews: unknown[];
  inlineComments: unknown[];
  reviewThreads: unknown[];
}): string | null {
  return createVersionedReviewedPrActivityCursor("v2", options);
}

function createVersionedReviewedPrActivityCursor(
  version: "v1" | "v2",
  options: {
    reviews: unknown[];
    inlineComments: unknown[];
    reviewThreads: unknown[];
  },
): string | null {
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
  ].map((entry) => stableJsonCodeUnit(entry));
  entries.sort(compareCodeUnits);
  const canonical = `[${entries.join(",")}]`;
  if (Buffer.byteLength(canonical, "utf8") > MAX_REVIEWED_PR_ACTIVITY_CURSOR_BYTES) return null;
  return `${version}:${entries.length}:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function readStableReviewedPrActivityCursor(readCursor: () => string | null): string | null {
  const first = readCursor();
  const second = readCursor();
  if (first !== second) throw new ReviewedPrActivityChangedDuringReadError();
  return second;
}

export function readStableReviewedPrActivityCursors(
  readCursors: () => Readonly<Record<string, string | null>>,
): Record<string, string | null> {
  const first = readCursors();
  const second = readCursors();
  const keys = new Set([...Object.keys(first), ...Object.keys(second)]);
  for (const key of keys) {
    if (!Object.hasOwn(first, key) || !Object.hasOwn(second, key) || first[key] !== second[key]) {
      throw new ReviewedPrActivityChangedDuringReadError();
    }
  }
  return { ...second };
}

export function isReviewedPrActivityCursor(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(CURSOR_PATTERN);
  if (!match) return false;
  const count = Number(match[2]);
  return Number.isSafeInteger(count) && count >= 0 && count <= MAX_REVIEWED_PR_ACTIVITY;
}

export function reviewedPrActivityCursorVersion(value: unknown): 1 | 2 | null {
  if (!isReviewedPrActivityCursor(value)) return null;
  return value.startsWith("v1:") ? 1 : 2;
}

export function compareReviewedPrActivityCursors(
  left: unknown,
  right: unknown,
): ReviewedPrActivityCursorComparison {
  const leftVersion = reviewedPrActivityCursorVersion(left);
  const rightVersion = reviewedPrActivityCursorVersion(right);
  if (leftVersion === null || rightVersion === null) return "changed";
  // GraphQL omits REST's immutable side/start_side fields. Re-baseline stored
  // v1 reports explicitly instead of claiming the independently hashed v2
  // representation proves either equality or activity drift.
  if (leftVersion !== rightVersion) return "rebaseline";
  return left === right ? "equal" : "changed";
}

export function reviewedPrActivityCursorV2Query(
  owner: string,
  name: string,
  numbers: readonly number[],
): string {
  if (!validGraphqlName(owner) || !validGraphqlName(name)) {
    throw new Error("invalid repository for reviewed PR activity v2 query");
  }
  const uniqueNumbers = validatedBatchNumbers(numbers);
  const pullRequests = uniqueNumbers
    .map(
      (number) => `pr_${number}: pullRequest(number: ${number}) {
        reviews(first: ${REVIEWED_PR_ACTIVITY_V2_CONNECTION_LIMIT}) {
          totalCount
          pageInfo { hasNextPage }
          nodes {
            fullDatabaseId
            author { login }
            state
            body
            submittedAt
            commit { oid }
          }
        }
        reviewThreads(first: ${REVIEWED_PR_ACTIVITY_V2_CONNECTION_LIMIT}) {
          totalCount
          pageInfo { hasNextPage }
          nodes {
            id
            isResolved
            comments(first: ${REVIEWED_PR_ACTIVITY_V2_CONNECTION_LIMIT}) {
              totalCount
              pageInfo { hasNextPage }
              nodes {
                fullDatabaseId
                pullRequestReview { fullDatabaseId }
                replyTo { fullDatabaseId }
                author { login }
                body
                createdAt
                updatedAt
                path
                line
                startLine
                originalLine
                originalCommit { oid }
                commit { oid }
              }
            }
          }
        }
      }`,
    )
    .join("\n");
  return `query ReviewedPrActivityCursorV2 {
    repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
      ${pullRequests}
    }
  }`;
}

export function reviewedPrActivityCursorsV2FromGraphql(
  value: unknown,
  numbers: readonly number[],
): ReviewedPrActivityCursorV2Batch {
  const uniqueNumbers = validatedBatchNumbers(numbers);
  const cursors: Record<string, string | null> = Object.fromEntries(
    uniqueNumbers.map((number) => [String(number), null]),
  );
  const failures: Record<string, string> = {};
  const response = record(value);
  if (Array.isArray(response.errors) && response.errors.length > 0) {
    for (const number of uniqueNumbers) failures[String(number)] = "graphql_errors";
    return { cursors, failures };
  }
  if (!hasOwn(response, "data")) {
    for (const number of uniqueNumbers) failures[String(number)] = "missing_data";
    return { cursors, failures };
  }
  const data = record(response.data);
  if (!hasOwn(data, "repository")) {
    for (const number of uniqueNumbers) failures[String(number)] = "missing_repository";
    return { cursors, failures };
  }
  const repository = record(data.repository);
  for (const number of uniqueNumbers) {
    const key = String(number);
    const alias = `pr_${number}`;
    if (!hasOwn(repository, alias) || repository[alias] === null) {
      failures[key] = "missing_pull_request";
      continue;
    }
    const decoded = decodeReviewedPrActivityCursorV2(repository[alias]);
    if (typeof decoded === "string") failures[key] = decoded;
    else cursors[key] = decoded.cursor;
  }
  return { cursors, failures };
}

export function reviewedPrActivityThreadsPageFromGraphql(
  value: unknown,
): ReviewedPrActivityThreadsPage | null {
  const response = record(value);
  if (Array.isArray(response.errors) && response.errors.length > 0) return null;
  const connection = record(record(record(response.data).repository).pullRequest).reviewThreads;
  const page = record(connection);
  const pageInfo = record(page.pageInfo);
  if (!Array.isArray(page.nodes) || typeof pageInfo.hasNextPage !== "boolean") return null;
  const threads: ReviewedPrActivityThreadsPage["threads"] = [];
  for (const node of page.nodes) {
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
  return { threads, hasNextPage: pageInfo.hasNextPage, endCursor };
}

function decodeReviewedPrActivityCursorV2(value: unknown): { cursor: string | null } | string {
  const pullRequest = record(value);
  if (!hasOwn(pullRequest, "reviews") || !hasOwn(pullRequest, "reviewThreads")) {
    return "missing_connections";
  }
  const reviewNodes = completeConnectionNodes(pullRequest.reviews);
  if (typeof reviewNodes === "string") return `reviews_${reviewNodes}`;
  const threadNodes = completeConnectionNodes(pullRequest.reviewThreads);
  if (typeof threadNodes === "string") return `review_threads_${threadNodes}`;

  const reviews: unknown[] = [];
  for (const value of reviewNodes) {
    const review = record(value);
    if (
      !requiredKeys(review, [
        "fullDatabaseId",
        "author",
        "state",
        "body",
        "submittedAt",
        "commit",
      ]) ||
      !databaseId(review.fullDatabaseId) ||
      typeof review.state !== "string" ||
      typeof review.body !== "string" ||
      !nullableString(review.submittedAt) ||
      !nullableLogin(review.author) ||
      !nullableOid(review.commit)
    ) {
      return "invalid_review_node";
    }
    reviews.push({
      id: scalar(review.fullDatabaseId),
      user: { login: nullableLoginValue(review.author) },
      state: review.state,
      body: review.body,
      submitted_at: review.submittedAt,
      commit_id: nullableOidValue(review.commit),
    });
  }

  const inlineComments: unknown[] = [];
  const reviewThreads: unknown[] = [];
  for (const value of threadNodes) {
    const thread = record(value);
    if (
      !requiredKeys(thread, ["id", "isResolved", "comments"]) ||
      typeof thread.id !== "string" ||
      thread.id.length === 0 ||
      typeof thread.isResolved !== "boolean"
    ) {
      return "invalid_review_thread_node";
    }
    const commentNodes = completeConnectionNodes(thread.comments);
    if (typeof commentNodes === "string") return `review_comments_${commentNodes}`;
    reviewThreads.push({ id: thread.id, isResolved: thread.isResolved });
    for (const commentValue of commentNodes) {
      const comment = record(commentValue);
      if (
        !requiredKeys(comment, [
          "fullDatabaseId",
          "pullRequestReview",
          "replyTo",
          "author",
          "body",
          "createdAt",
          "updatedAt",
          "path",
          "line",
          "startLine",
          "originalLine",
          "originalCommit",
          "commit",
        ]) ||
        !databaseId(comment.fullDatabaseId) ||
        !nullableDatabaseIdObject(comment.pullRequestReview) ||
        !nullableDatabaseIdObject(comment.replyTo) ||
        !nullableLogin(comment.author) ||
        typeof comment.body !== "string" ||
        typeof comment.createdAt !== "string" ||
        typeof comment.updatedAt !== "string" ||
        typeof comment.path !== "string" ||
        !nullableInteger(comment.line) ||
        !nullableInteger(comment.startLine) ||
        !nullableInteger(comment.originalLine) ||
        !nullableOid(comment.originalCommit) ||
        !nullableOid(comment.commit)
      ) {
        return "invalid_review_comment_node";
      }
      inlineComments.push({
        id: scalar(comment.fullDatabaseId),
        pull_request_review_id: nullableDatabaseIdValue(comment.pullRequestReview),
        in_reply_to_id: nullableDatabaseIdValue(comment.replyTo),
        user: { login: nullableLoginValue(comment.author) },
        body: comment.body,
        created_at: comment.createdAt,
        updated_at: comment.updatedAt,
        path: comment.path,
        line: comment.line,
        start_line: comment.startLine,
        original_line: comment.originalLine,
        original_commit_id: nullableOidValue(comment.originalCommit),
        commit_id: nullableOidValue(comment.commit),
      });
    }
  }

  return {
    cursor: createReviewedPrActivityCursorV2({ reviews, inlineComments, reviewThreads }),
  };
}

function completeConnectionNodes(value: unknown): unknown[] | string {
  const connection = record(value);
  if (!requiredKeys(connection, ["totalCount", "pageInfo", "nodes"])) return "missing_fields";
  const pageInfo = record(connection.pageInfo);
  if (!hasOwn(pageInfo, "hasNextPage") || pageInfo.hasNextPage !== false) {
    return pageInfo.hasNextPage === true ? "truncated" : "invalid_page_info";
  }
  if (!Number.isSafeInteger(connection.totalCount) || Number(connection.totalCount) < 0) {
    return "invalid_total_count";
  }
  if (!Array.isArray(connection.nodes)) return "invalid_nodes";
  if (connection.nodes.length !== Number(connection.totalCount)) return "partial_nodes";
  return connection.nodes;
}

function validatedBatchNumbers(numbers: readonly number[]): number[] {
  const unique = [...new Set(numbers)];
  if (unique.length > MAX_REVIEWED_PR_ACTIVITY_BATCH_SIZE) {
    throw new Error(
      `reviewed PR activity v2 batch exceeds ${MAX_REVIEWED_PR_ACTIVITY_BATCH_SIZE} pull requests`,
    );
  }
  if (unique.some((number) => !Number.isSafeInteger(number) || number <= 0)) {
    throw new Error("reviewed PR activity v2 batch contains an invalid pull request number");
  }
  return unique.sort((left, right) => left - right);
}

function requiredKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => hasOwn(value, key));
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function databaseId(value: unknown): boolean {
  return (
    (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) ||
    (Number.isSafeInteger(value) && Number(value) > 0)
  );
}

function nullableDatabaseIdObject(value: unknown): boolean {
  return (
    value === null ||
    (hasOwn(record(value), "fullDatabaseId") && databaseId(record(value).fullDatabaseId))
  );
}

function nullableDatabaseIdValue(value: unknown): string {
  return value === null ? "" : scalar(record(value).fullDatabaseId);
}

function nullableLogin(value: unknown): boolean {
  return (
    value === null || (hasOwn(record(value), "login") && typeof record(value).login === "string")
  );
}

function nullableLoginValue(value: unknown): string {
  return value === null ? "" : scalar(record(value).login);
}

function nullableOid(value: unknown): boolean {
  return value === null || (hasOwn(record(value), "oid") && typeof record(value).oid === "string");
}

function nullableOidValue(value: unknown): string {
  return value === null ? "" : scalar(record(value).oid);
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function nullableInteger(value: unknown): boolean {
  return value === null || Number.isSafeInteger(value);
}

function validGraphqlName(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value);
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

function scalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return stableJsonCodeUnit(value);
}

function digestScalar(value: unknown): string {
  return createHash("sha256").update(scalar(value)).digest("hex");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
