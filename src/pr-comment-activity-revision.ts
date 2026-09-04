import { createHash } from "node:crypto";
import { compareCodeUnits, stableJson } from "./stable-json.js";
import { recordOrEmpty as jsonRecord } from "./value-coerce.js";

export const PR_ACTIVITY_REVISION_QUERY_PAGE_SIZE = 100;
export const PR_ACTIVITY_REVISION_CONNECTION_LIMIT = 40;

export function fetchPrCommentActivityRevision(options: {
  repo: string;
  number: number;
  ghJson: <T>(args: string[]) => T;
}): string | null {
  const [owner, name] = options.repo.split("/");
  if (!validGraphQlName(owner) || !validGraphQlName(name)) return null;
  const response = options.ghJson<unknown>([
    "api",
    "graphql",
    "-f",
    `query=${prCommentActivityRevisionQuery(owner, name, [options.number])}`,
  ]);
  const root = jsonRecord(response);
  if (Array.isArray(root.errors) && root.errors.length > 0) {
    throw new Error("GitHub GraphQL returned errors");
  }
  const repository = jsonRecord(jsonRecord(root.data).repository);
  return prCommentActivityRevision(repository[`pr_${options.number}`]);
}

export function prCommentActivityRevisionQuery(
  owner: string,
  name: string,
  numbers: readonly number[],
): string {
  const pullRequests = numbers
    .map(
      (number) => `pr_${number}: pullRequest(number: ${number}) {
        reviews { totalCount }
        reviewThreads(first: ${PR_ACTIVITY_REVISION_CONNECTION_LIMIT}) {
          totalCount
          pageInfo { hasNextPage }
          nodes {
            id
            comments(first: ${PR_ACTIVITY_REVISION_CONNECTION_LIMIT}) {
              totalCount
              pageInfo { hasNextPage }
              nodes { id updatedAt }
            }
          }
        }
      }`,
    )
    .join("\n");
  return `query PlannedPrCommentActivityRevision {
    repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
      ${pullRequests}
    }
  }`;
}

export function prCommentActivityRevision(value: unknown): string | null {
  const pullRequest = jsonRecord(value);
  const reviews = jsonRecord(pullRequest.reviews);
  const reviewThreads = jsonRecord(pullRequest.reviewThreads);
  const reviewCount = nonnegativeIntegerOrNull(reviews.totalCount);
  const threadCount = nonnegativeIntegerOrNull(reviewThreads.totalCount);
  const threadNodes = Array.isArray(reviewThreads.nodes) ? reviewThreads.nodes : null;
  if (
    reviewCount === null ||
    threadCount === null ||
    jsonRecord(reviewThreads.pageInfo).hasNextPage !== false ||
    !threadNodes ||
    threadNodes.length !== threadCount
  ) {
    return null;
  }

  const threads: Array<{
    id: string;
    commentCount: number;
    comments: Array<{ id: string; updatedAt: string }>;
  }> = [];
  for (const threadValue of threadNodes) {
    const thread = jsonRecord(threadValue);
    const id = typeof thread.id === "string" ? thread.id : null;
    const comments = jsonRecord(thread.comments);
    const commentCount = nonnegativeIntegerOrNull(comments.totalCount);
    const commentNodes = Array.isArray(comments.nodes) ? comments.nodes : null;
    if (
      !id ||
      commentCount === null ||
      jsonRecord(comments.pageInfo).hasNextPage !== false ||
      !commentNodes ||
      commentNodes.length !== commentCount
    ) {
      return null;
    }
    const normalizedComments: Array<{ id: string; updatedAt: string }> = [];
    for (const commentValue of commentNodes) {
      const comment = jsonRecord(commentValue);
      if (
        typeof comment.id !== "string" ||
        typeof comment.updatedAt !== "string" ||
        !Number.isFinite(Date.parse(comment.updatedAt))
      ) {
        return null;
      }
      normalizedComments.push({ id: comment.id, updatedAt: comment.updatedAt });
    }
    normalizedComments.sort((left, right) => compareCodeUnits(left.id, right.id));
    threads.push({ id, commentCount, comments: normalizedComments });
  }
  threads.sort((left, right) => compareCodeUnits(left.id, right.id));
  return `sha256:${createHash("sha256")
    .update(stableJson({ reviewCount, threadCount, threads }))
    .digest("hex")}`;
}

function nonnegativeIntegerOrNull(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function validGraphQlName(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]+$/.test(value);
}
