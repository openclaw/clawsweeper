import { createHash } from "node:crypto";

import { REVIEW_CACHE_MAX_AGE_DAYS } from "./scheduler-policy.js";
import { stableJson } from "./stable-json.js";

export const REVIEW_STRUCTURAL_CACHE_VERSION = 3;
export const REVIEW_STRUCTURAL_CACHE_MAX_AGE_DAYS = REVIEW_CACHE_MAX_AGE_DAYS;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_MACHINE_METADATA_CHARS = 64 * 1024;
const SHA_PATTERN = /^[0-9a-f]{40,64}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export type ReviewStructuralKind = "issue" | "pull_request";

export interface ReviewStructuralActivity {
  id: string;
  updatedAt: string;
  author: string | null;
  authorAssociation: string | null;
  state: string | null;
  commitSha: string | null;
  bodyDigest: string | null;
}

export interface ReviewStructuralThread {
  id: string;
  isResolved: boolean;
  comments: readonly ReviewStructuralActivity[];
  commentsTruncated: boolean;
}

export interface ReviewStructuralPullMetadata {
  headSha: string;
  baseSha: string;
  draft: boolean;
  mergeable: string;
  mergeStateStatus: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commitCount: number;
  reviews: readonly ReviewStructuralActivity[];
  reviewsTruncated: boolean;
  reviewThreads: readonly ReviewStructuralThread[];
  reviewThreadsTruncated: boolean;
}

export interface ReviewStructuralSnapshot {
  repo: string;
  number: number;
  kind: ReviewStructuralKind;
  nodeId: string;
  author: string;
  authorAssociation: string;
  titleDigest: string;
  bodyDigest: string;
  state: string;
  locked: boolean;
  labels: readonly string[];
  labelsTruncated: boolean;
  activityUpdatedAt: string;
  comments: readonly ReviewStructuralActivity[];
  commentsTruncated: boolean;
  timeline: readonly unknown[];
  timelineTruncated: boolean;
  relationSensitive: boolean;
  targetHeadSha: string;
  latestReleaseTag: string | null;
  latestReleaseSha: string | null;
  pull: ReviewStructuralPullMetadata | null;
}

export interface ReviewStructuralRecord {
  version: typeof REVIEW_STRUCTURAL_CACHE_VERSION;
  fingerprint: string;
  kind: ReviewStructuralKind;
  sourceRevision: string;
  itemStateDigest: string;
  activityUpdatedAt: string;
  relationSensitive: boolean;
  targetHeadSha: string;
  pullHeadSha: string | null;
  pullStateDigest: string | null;
  reviewPolicy: string;
  reviewModel: string;
}

export interface ReviewStructuralPullState {
  headSha: string;
  baseSha: string;
  draft: boolean;
  mergeable: string | boolean | null;
  mergeStateStatus: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commitCount: number;
}

export interface ReviewStructuralItemState {
  titleDigest: string;
  bodyDigest: string;
  state: string;
  locked: boolean;
  author: string;
  authorAssociation: string;
  labels: readonly string[];
  comments: readonly Pick<
    ReviewStructuralActivity,
    "updatedAt" | "author" | "authorAssociation" | "bodyDigest"
  >[];
}

export interface ReviewStructuralPriorReview {
  reviewStatus?: string | undefined;
  decision?: string | undefined;
  lastFullReviewAt?: string | undefined;
  lastFullReviewDecision?: string | undefined;
  reviewPolicy?: string | undefined;
  reviewModel?: string | undefined;
  itemSourceRevision?: string | undefined;
  reviewCommentSyncedAt?: string | undefined;
  labelsSyncedAt?: string | undefined;
}

export type ReviewStructuralCacheReason =
  | "hit"
  | "explicit_dispatch"
  | "maintainer_request"
  | "coordination_disabled"
  | "missing_review"
  | "incomplete_review"
  | "missing_lease_revision"
  | "non_keep_open_verdict"
  | "policy_changed"
  | "model_changed"
  | "stale_review"
  | "missing_or_invalid_record"
  | "item_kind_changed"
  | "source_changed"
  | "activity_changed"
  | "relation_context_present"
  | "target_changed"
  | "pull_head_changed";

export interface ReviewStructuralCacheDecision {
  hit: boolean;
  reason: ReviewStructuralCacheReason;
}

export interface ReviewStructuralCacheProbeOptions {
  review: ReviewStructuralPriorReview | null;
  reviewPolicy: string;
  reviewModel: string;
  explicitDispatch: boolean;
  maintainerRequest: boolean;
  coordinationEnabled: boolean;
  now?: number;
}

export interface ReviewStructuralGraphqlOptions {
  response: unknown;
  repo: string;
  number: number;
  kind: ReviewStructuralKind;
  targetHeadSha: string;
  latestReleaseTag: string | null;
  latestReleaseSha: string | null;
  reviewPolicy: string;
  reviewModel: string;
  ignoreAuthor: (author: string) => boolean;
  ignoreLabel: (label: string) => boolean;
  externalRelationSensitive?: boolean;
}

const REVIEW_STRUCTURAL_TIMELINE_QUERY = `
  timelineItems(last: 100) {
    pageInfo { hasPreviousPage }
    nodes {
      __typename
      ... on Node { id }
      ... on IssueComment {
        updatedAt
        body
        author { login }
      }
      ... on LabeledEvent {
        createdAt
        actor { login }
        label { name }
      }
      ... on UnlabeledEvent {
        createdAt
        actor { login }
        label { name }
      }
      ... on CrossReferencedEvent {
        createdAt
        willCloseTarget
        source {
          __typename
          ... on Issue {
            id
            number
            state
            updatedAt
            repository { nameWithOwner }
          }
          ... on PullRequest {
            id
            number
            state
            updatedAt
            headRefOid
            repository { nameWithOwner }
          }
        }
      }
      ... on ConnectedEvent {
        createdAt
        subject {
          __typename
          ... on Issue {
            id
            number
            state
            updatedAt
            repository { nameWithOwner }
          }
          ... on PullRequest {
            id
            number
            state
            updatedAt
            headRefOid
            repository { nameWithOwner }
          }
        }
      }
    }
  }
`;

const REVIEW_STRUCTURAL_COMMON_QUERY = `
  id
  number
  title
  body
  state
  locked
  updatedAt
  author { login }
  authorAssociation
  labels(first: 100) {
    pageInfo { hasNextPage }
    nodes { name }
  }
  comments(last: 100) {
    pageInfo { hasPreviousPage }
    nodes {
      id
      updatedAt
      body
      author { login }
      authorAssociation
    }
  }
  ${REVIEW_STRUCTURAL_TIMELINE_QUERY}
`;

export function reviewStructuralQuery(kind: ReviewStructuralKind): string {
  const field = kind === "pull_request" ? "pullRequest" : "issue";
  const pullFields =
    kind === "pull_request"
      ? `
        headRefOid
        baseRefOid
        isDraft
        mergeable
        mergeStateStatus
        additions
        deletions
        changedFiles
        commits(first: 1) { totalCount }
        reviews(last: 100) {
          pageInfo { hasPreviousPage }
          nodes {
            id
            updatedAt
            body
            author { login }
            authorAssociation
            state
            commit { oid }
          }
        }
        reviewThreads(last: 100) {
          pageInfo { hasPreviousPage }
          nodes {
            id
            isResolved
            comments(last: 100) {
              pageInfo { hasPreviousPage }
              nodes {
                id
                updatedAt
                body
                author { login }
                authorAssociation
              }
            }
          }
        }
      `
      : "";
  return `
    query ReviewStructuralMetadata($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        ${field}(number: $number) {
          ${REVIEW_STRUCTURAL_COMMON_QUERY}
          ${pullFields}
        }
      }
    }
  `;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | null {
  const number =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.floor(number);
}

function structuralConnection(
  value: unknown,
  direction: "first" | "last",
): {
  nodes: unknown[];
  truncated: boolean;
} {
  const connection = asRecord(value);
  const nodes = connection.nodes;
  const pageInfo = asRecord(connection.pageInfo);
  if (!Array.isArray(nodes)) return { nodes: [], truncated: true };
  const boundary = direction === "first" ? pageInfo.hasNextPage : pageInfo.hasPreviousPage;
  return {
    nodes,
    truncated: boundary !== false,
  };
}

function structuralActivities(
  value: unknown,
  ignoreAuthor: (author: string) => boolean,
): {
  activities: ReviewStructuralActivity[];
  truncated: boolean;
} {
  const connection = structuralConnection(value, "last");
  let malformed = false;
  const activities = connection.nodes.flatMap((entry) => {
    const record = asRecord(entry);
    const id = stringOrUndefined(record.id);
    const updatedAt = stringOrUndefined(record.updatedAt);
    const author = stringOrUndefined(asRecord(record.author).login) ?? null;
    const authorAssociation = stringOrUndefined(record.authorAssociation) ?? null;
    const state = stringOrUndefined(record.state) ?? null;
    const commitSha = stringOrUndefined(asRecord(record.commit).oid) ?? null;
    const hasBody = typeof record.body === "string" || record.body === null;
    const bodyDigest =
      typeof record.body === "string"
        ? sha256(record.body)
        : record.body === null
          ? sha256("")
          : null;
    if (!id || !updatedAt || !hasBody) {
      malformed = true;
      return [];
    }
    if (author && ignoreAuthor(author)) return [];
    return [{ id, updatedAt, author, authorAssociation, state, commitSha, bodyDigest }];
  });
  return { activities, truncated: connection.truncated || malformed };
}

export function reviewStructuralActivitiesForTest(
  value: unknown,
  ignoredAuthors: readonly string[] = [],
): {
  activities: ReviewStructuralActivity[];
  truncated: boolean;
} {
  const ignored = new Set(ignoredAuthors.map((author) => author.toLowerCase()));
  return structuralActivities(value, (author) => ignored.has(author.toLowerCase()));
}

function structuralLabels(
  value: unknown,
  ignoreLabel: (label: string) => boolean,
): {
  labels: string[];
  truncated: boolean;
} {
  const connection = structuralConnection(value, "first");
  let malformed = false;
  const labels = connection.nodes.flatMap((entry) => {
    const name = stringOrUndefined(asRecord(entry).name);
    if (!name) {
      malformed = true;
      return [];
    }
    return ignoreLabel(name) ? [] : [name];
  });
  return { labels, truncated: connection.truncated || malformed };
}

function structuralRelationTarget(value: unknown): unknown {
  const target = asRecord(value);
  const repository = stringOrUndefined(asRecord(target.repository).nameWithOwner);
  const type = stringOrUndefined(target.__typename);
  const id = stringOrUndefined(target.id);
  const number = nonNegativeInteger(target.number);
  const state = stringOrUndefined(target.state);
  const updatedAt = stringOrUndefined(target.updatedAt);
  const headSha = stringOrUndefined(target.headRefOid)?.trim().toLowerCase() ?? null;
  if (
    (type !== "Issue" && type !== "PullRequest") ||
    !id ||
    !repository ||
    number === null ||
    !state ||
    !updatedAt ||
    !validTimestamp(updatedAt) ||
    (type === "PullRequest" && (!headSha || !SHA_PATTERN.test(headSha)))
  ) {
    return null;
  }
  return {
    type,
    id,
    repository,
    number,
    state,
    updatedAt,
    headSha: type === "PullRequest" ? headSha : null,
  };
}

function relatedItemReference(value: unknown, repo: string, currentNumber: number): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  const [owner, name] = repo.split("/");
  if (!owner || !name) return false;
  const escapedRepo = `${escapeRegExp(owner)}\\/${escapeRegExp(name)}`;
  for (const match of value.matchAll(
    new RegExp(
      `github\\.com\\/${escapedRepo}\\/(?:issues|pull)\\/(\\d+)|(?<![\\w/])#(\\d+)\\b`,
      "g",
    ),
  )) {
    const number = Number(match[1] ?? match[2]);
    if (Number.isInteger(number) && number > 0 && number !== currentNumber) return true;
  }
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commentRelationSensitivity(
  value: unknown,
  options: ReviewStructuralGraphqlOptions,
): boolean | null {
  const connection = structuralConnection(value, "last");
  if (connection.truncated) return null;
  for (const entry of connection.nodes) {
    const record = asRecord(entry);
    const author = stringOrUndefined(asRecord(record.author).login);
    if (author && options.ignoreAuthor(author)) continue;
    if (typeof record.body !== "string") return null;
    if (relatedItemReference(record.body, options.repo, options.number)) return true;
  }
  return false;
}

function timelineRelationSensitivity(
  value: unknown,
  options: ReviewStructuralGraphqlOptions,
): boolean | null {
  const connection = structuralConnection(value, "last");
  if (connection.truncated) return null;
  for (const entry of connection.nodes) {
    const record = asRecord(entry);
    const type = stringOrUndefined(record.__typename);
    if (!type) return null;
    if (type === "CrossReferencedEvent" || type === "ConnectedEvent") return true;
    if (type !== "IssueComment") continue;
    const author = stringOrUndefined(asRecord(record.author).login);
    if (author && options.ignoreAuthor(author)) continue;
    if (typeof record.body !== "string") return null;
    if (relatedItemReference(record.body, options.repo, options.number)) return true;
  }
  return false;
}

function reviewThreadRelationSensitivity(
  value: unknown,
  options: ReviewStructuralGraphqlOptions,
): boolean | null {
  const connection = structuralConnection(value, "last");
  if (connection.truncated) return null;
  for (const entry of connection.nodes) {
    const sensitive = commentRelationSensitivity(asRecord(entry).comments, options);
    if (sensitive === null) return null;
    if (sensitive) return true;
  }
  return false;
}

function structuralTimeline(
  value: unknown,
  ignoreAuthor: (author: string) => boolean,
  ignoreLabel: (label: string) => boolean,
): {
  timeline: unknown[];
  truncated: boolean;
} {
  const connection = structuralConnection(value, "last");
  let malformed = false;
  const timeline = connection.nodes.flatMap((entry) => {
    const record = asRecord(entry);
    const type = stringOrUndefined(record.__typename);
    const id = stringOrUndefined(record.id);
    const author =
      stringOrUndefined(asRecord(record.author).login) ??
      stringOrUndefined(asRecord(record.actor).login) ??
      null;
    const label = stringOrUndefined(asRecord(record.label).name) ?? null;
    if (!type || !id) {
      malformed = true;
      return [];
    }
    if (author && ignoreAuthor(author)) return [];
    if (label && ignoreLabel(label)) return [];
    const relationTarget =
      type === "CrossReferencedEvent" || type === "ConnectedEvent"
        ? structuralRelationTarget(record.source ?? record.subject)
        : null;
    if ((type === "CrossReferencedEvent" || type === "ConnectedEvent") && relationTarget === null) {
      malformed = true;
      return [];
    }
    return [
      {
        type,
        id,
        createdAt: stringOrUndefined(record.createdAt) ?? null,
        updatedAt: stringOrUndefined(record.updatedAt) ?? null,
        author,
        label,
        willCloseTarget:
          typeof record.willCloseTarget === "boolean" ? record.willCloseTarget : null,
        target: relationTarget,
      },
    ];
  });
  return { timeline, truncated: connection.truncated || malformed };
}

function structuralReviewThreads(
  value: unknown,
  ignoreAuthor: (author: string) => boolean,
): {
  threads: ReviewStructuralThread[];
  truncated: boolean;
} {
  const connection = structuralConnection(value, "last");
  let malformed = false;
  const threads = connection.nodes.flatMap((entry) => {
    const record = asRecord(entry);
    const id = stringOrUndefined(record.id);
    if (!id || typeof record.isResolved !== "boolean") {
      malformed = true;
      return [];
    }
    const comments = structuralActivities(record.comments, ignoreAuthor);
    return [
      {
        id,
        isResolved: record.isResolved,
        comments: comments.activities,
        commentsTruncated: comments.truncated,
      },
    ];
  });
  return { threads, truncated: connection.truncated || malformed };
}

export function reviewStructuralRecordFromGraphql(
  options: ReviewStructuralGraphqlOptions,
): ReviewStructuralRecord | null {
  const response = asRecord(options.response);
  const repository = asRecord(asRecord(response.data).repository);
  const node = asRecord(
    options.kind === "pull_request" ? repository.pullRequest : repository.issue,
  );
  const id = stringOrUndefined(node.id);
  const number = nonNegativeInteger(node.number);
  const title = stringOrUndefined(node.title);
  const author = stringOrUndefined(asRecord(node.author).login);
  const authorAssociation = stringOrUndefined(node.authorAssociation);
  const body = node.body;
  const state = stringOrUndefined(node.state);
  const updatedAt = stringOrUndefined(node.updatedAt);
  if (
    !id ||
    number !== options.number ||
    title === undefined ||
    !author ||
    !authorAssociation ||
    (typeof body !== "string" && body !== null) ||
    !state ||
    typeof node.locked !== "boolean" ||
    !updatedAt
  ) {
    return null;
  }
  const labels = structuralLabels(node.labels, options.ignoreLabel);
  const comments = structuralActivities(node.comments, options.ignoreAuthor);
  const timeline = structuralTimeline(
    node.timelineItems,
    options.ignoreAuthor,
    options.ignoreLabel,
  );
  const commentRelations = commentRelationSensitivity(node.comments, options);
  const timelineRelations = timelineRelationSensitivity(node.timelineItems, options);
  if (commentRelations === null || timelineRelations === null) return null;
  let relationSensitive =
    options.externalRelationSensitive === true ||
    relatedItemReference(body, options.repo, options.number) ||
    commentRelations ||
    timelineRelations;
  const snapshot: ReviewStructuralSnapshot = {
    repo: options.repo,
    number: options.number,
    kind: options.kind,
    nodeId: id,
    author,
    authorAssociation,
    titleDigest: sha256(title),
    bodyDigest: sha256(typeof body === "string" ? body : ""),
    state,
    locked: node.locked,
    labels: labels.labels,
    labelsTruncated: labels.truncated,
    activityUpdatedAt: updatedAt,
    comments: comments.activities,
    commentsTruncated: comments.truncated,
    timeline: timeline.timeline,
    timelineTruncated: timeline.truncated,
    relationSensitive,
    targetHeadSha: options.targetHeadSha.trim().toLowerCase(),
    latestReleaseTag: options.latestReleaseTag,
    latestReleaseSha: options.latestReleaseSha?.trim().toLowerCase() ?? null,
    pull: null,
  };
  if (options.kind === "pull_request") {
    const reviews = structuralActivities(node.reviews, options.ignoreAuthor);
    const reviewThreads = structuralReviewThreads(node.reviewThreads, options.ignoreAuthor);
    const reviewThreadRelations = reviewThreadRelationSensitivity(node.reviewThreads, options);
    const headSha = stringOrUndefined(node.headRefOid)?.trim().toLowerCase();
    const baseSha = stringOrUndefined(node.baseRefOid)?.trim().toLowerCase();
    const additions = nonNegativeInteger(node.additions);
    const deletions = nonNegativeInteger(node.deletions);
    const changedFiles = nonNegativeInteger(node.changedFiles);
    const commitCount = nonNegativeInteger(asRecord(node.commits).totalCount);
    if (
      !headSha ||
      !baseSha ||
      typeof node.isDraft !== "boolean" ||
      !stringOrUndefined(node.mergeable) ||
      !stringOrUndefined(node.mergeStateStatus) ||
      additions === null ||
      deletions === null ||
      changedFiles === null ||
      commitCount === null
    ) {
      return null;
    }
    if (reviewThreadRelations === null) return null;
    relationSensitive ||= reviewThreadRelations;
    snapshot.relationSensitive = relationSensitive;
    snapshot.pull = {
      headSha,
      baseSha,
      draft: node.isDraft,
      mergeable: String(node.mergeable),
      mergeStateStatus: String(node.mergeStateStatus),
      additions,
      deletions,
      changedFiles,
      commitCount,
      reviews: reviews.activities,
      reviewsTruncated: reviews.truncated,
      reviewThreads: reviewThreads.threads,
      reviewThreadsTruncated: reviewThreads.truncated,
    };
  }
  return createReviewStructuralRecord(snapshot, {
    reviewPolicy: options.reviewPolicy,
    reviewModel: options.reviewModel,
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validTimestamp(value: string): boolean {
  return value.length > 0 && Number.isFinite(Date.parse(value));
}

function validActivity(activity: ReviewStructuralActivity): boolean {
  return (
    activity.id.length > 0 &&
    activity.id.length <= 128 &&
    validTimestamp(activity.updatedAt) &&
    (activity.author === null || activity.author.length <= 128) &&
    (activity.authorAssociation === null || activity.authorAssociation.length <= 64) &&
    (activity.state === null || activity.state.length <= 64) &&
    (activity.commitSha === null || SHA_PATTERN.test(activity.commitSha)) &&
    (activity.bodyDigest === null || DIGEST_PATTERN.test(activity.bodyDigest))
  );
}

function validMachineMetadata(value: unknown): boolean {
  const serialized = stableJson(value);
  return serialized.length > 0 && serialized.length <= MAX_MACHINE_METADATA_CHARS;
}

function normalizedActivities(
  activities: readonly ReviewStructuralActivity[],
): ReviewStructuralActivity[] {
  return [...activities]
    .map((activity) => ({
      id: activity.id,
      updatedAt: activity.updatedAt,
      author: activity.author?.toLowerCase() ?? null,
      authorAssociation: activity.authorAssociation?.toUpperCase() ?? null,
      state: activity.state?.toUpperCase() ?? null,
      commitSha: activity.commitSha,
      bodyDigest: activity.bodyDigest,
    }))
    .sort(
      (left, right) =>
        left.id.localeCompare(right.id) ||
        left.updatedAt.localeCompare(right.updatedAt) ||
        String(left.author).localeCompare(String(right.author)),
    );
}

function sourceRevision(snapshot: ReviewStructuralSnapshot): string {
  return sha256(
    stableJson({
      repo: snapshot.repo,
      number: snapshot.number,
      kind: snapshot.kind,
      nodeId: snapshot.nodeId,
      author: snapshot.author.toLowerCase(),
      authorAssociation: snapshot.authorAssociation.toUpperCase(),
      titleDigest: snapshot.titleDigest,
      bodyDigest: snapshot.bodyDigest,
      state: snapshot.state,
      locked: snapshot.locked,
      labels: [...snapshot.labels].map((label) => label.toLowerCase()).sort(),
      comments: normalizedActivities(snapshot.comments),
      timeline: snapshot.timeline,
      relationSensitive: snapshot.relationSensitive,
      latestRelease: {
        tag: snapshot.latestReleaseTag,
        sha: snapshot.latestReleaseSha,
      },
      pull:
        snapshot.pull === null
          ? null
          : {
              baseSha: snapshot.pull.baseSha,
              draft: snapshot.pull.draft,
              mergeable: snapshot.pull.mergeable,
              mergeStateStatus: snapshot.pull.mergeStateStatus,
              additions: snapshot.pull.additions,
              deletions: snapshot.pull.deletions,
              changedFiles: snapshot.pull.changedFiles,
              commitCount: snapshot.pull.commitCount,
              reviews: normalizedActivities(snapshot.pull.reviews),
              reviewThreads: [...snapshot.pull.reviewThreads]
                .map((thread) => ({
                  id: thread.id,
                  isResolved: thread.isResolved,
                  comments: normalizedActivities(thread.comments),
                }))
                .sort((left, right) => left.id.localeCompare(right.id)),
            },
    }),
  );
}

function recordFingerprint(record: Omit<ReviewStructuralRecord, "fingerprint">): string {
  return sha256(stableJson(record));
}

export function reviewStructuralItemStateDigest(item: ReviewStructuralItemState): string | null {
  if (
    !DIGEST_PATTERN.test(item.titleDigest) ||
    !DIGEST_PATTERN.test(item.bodyDigest) ||
    !item.state ||
    item.state.length > 64 ||
    !item.author ||
    item.author.length > 128 ||
    !item.authorAssociation ||
    item.authorAssociation.length > 64 ||
    item.labels.length > 100 ||
    item.comments.length > 100 ||
    item.comments.some(
      (comment) =>
        !validTimestamp(comment.updatedAt) ||
        (comment.author !== null && comment.author.length > 128) ||
        (comment.authorAssociation !== null && comment.authorAssociation.length > 64) ||
        comment.bodyDigest === null ||
        !DIGEST_PATTERN.test(comment.bodyDigest),
    )
  ) {
    return null;
  }
  const comments = item.comments
    .map((comment) => ({
      updatedAt: comment.updatedAt,
      author: comment.author?.toLowerCase() ?? null,
      authorAssociation: comment.authorAssociation?.toUpperCase() ?? null,
      bodyDigest: comment.bodyDigest,
    }))
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  return sha256(
    stableJson({
      titleDigest: item.titleDigest,
      bodyDigest: item.bodyDigest,
      state: item.state.toUpperCase(),
      locked: item.locked,
      author: item.author.toLowerCase(),
      authorAssociation: item.authorAssociation.toUpperCase(),
      labels: [...item.labels].map((label) => label.toLowerCase()).sort(),
      comments,
    }),
  );
}

function normalizedMergeable(value: ReviewStructuralPullState["mergeable"]): string | null {
  if (value === true) return "MERGEABLE";
  if (value === false) return "CONFLICTING";
  if (value === null) return "UNKNOWN";
  const normalized = value.trim().toUpperCase();
  return normalized ? normalized : null;
}

export function reviewStructuralPullStateDigest(pull: ReviewStructuralPullState): string | null {
  const headSha = pull.headSha.trim().toLowerCase();
  const baseSha = pull.baseSha.trim().toLowerCase();
  const mergeable = normalizedMergeable(pull.mergeable);
  const mergeStateStatus = pull.mergeStateStatus.trim().toUpperCase();
  const counts = [pull.additions, pull.deletions, pull.changedFiles, pull.commitCount];
  if (
    !SHA_PATTERN.test(headSha) ||
    !SHA_PATTERN.test(baseSha) ||
    typeof pull.draft !== "boolean" ||
    !mergeable ||
    mergeable.length > 64 ||
    !mergeStateStatus ||
    mergeStateStatus.length > 64 ||
    counts.some((value) => !Number.isSafeInteger(value) || value < 0)
  ) {
    return null;
  }
  return sha256(
    stableJson({
      headSha,
      baseSha,
      draft: pull.draft,
      mergeable,
      mergeStateStatus,
      additions: pull.additions,
      deletions: pull.deletions,
      changedFiles: pull.changedFiles,
      commitCount: pull.commitCount,
    }),
  );
}

function validPullMetadata(pull: ReviewStructuralPullMetadata): boolean {
  return (
    SHA_PATTERN.test(pull.headSha) &&
    SHA_PATTERN.test(pull.baseSha) &&
    pull.mergeable.length > 0 &&
    pull.mergeable.length <= 64 &&
    pull.mergeStateStatus.length > 0 &&
    pull.mergeStateStatus.length <= 64 &&
    Number.isSafeInteger(pull.additions) &&
    pull.additions >= 0 &&
    Number.isSafeInteger(pull.deletions) &&
    pull.deletions >= 0 &&
    Number.isSafeInteger(pull.changedFiles) &&
    pull.changedFiles >= 0 &&
    Number.isSafeInteger(pull.commitCount) &&
    pull.commitCount >= 0 &&
    !pull.reviewsTruncated &&
    pull.reviews.every(validActivity) &&
    !pull.reviewThreadsTruncated &&
    pull.reviewThreads.every(
      (thread) =>
        thread.id.length > 0 &&
        thread.id.length <= 128 &&
        !thread.commentsTruncated &&
        thread.comments.every(validActivity),
    )
  );
}

export function createReviewStructuralRecord(
  snapshot: ReviewStructuralSnapshot,
  options: { reviewPolicy: string; reviewModel: string },
): ReviewStructuralRecord | null {
  if (
    !snapshot.repo ||
    !Number.isSafeInteger(snapshot.number) ||
    snapshot.number < 0 ||
    !snapshot.nodeId ||
    !snapshot.author ||
    snapshot.author.length > 128 ||
    !snapshot.authorAssociation ||
    snapshot.authorAssociation.length > 64 ||
    !DIGEST_PATTERN.test(snapshot.titleDigest) ||
    !DIGEST_PATTERN.test(snapshot.bodyDigest) ||
    !snapshot.state ||
    snapshot.labelsTruncated ||
    snapshot.labels.length > 100 ||
    !validTimestamp(snapshot.activityUpdatedAt) ||
    snapshot.commentsTruncated ||
    snapshot.comments.length > 100 ||
    !snapshot.comments.every(validActivity) ||
    snapshot.timelineTruncated ||
    snapshot.timeline.length > 100 ||
    typeof snapshot.relationSensitive !== "boolean" ||
    !validMachineMetadata(snapshot.timeline) ||
    !validMachineMetadata({
      comments: snapshot.comments,
      reviews: snapshot.pull?.reviews ?? [],
      reviewThreads: snapshot.pull?.reviewThreads ?? [],
    }) ||
    !SHA_PATTERN.test(snapshot.targetHeadSha) ||
    (snapshot.latestReleaseTag !== null &&
      (snapshot.latestReleaseTag.length === 0 || snapshot.latestReleaseTag.length > 128)) ||
    (snapshot.latestReleaseSha !== null && !SHA_PATTERN.test(snapshot.latestReleaseSha)) ||
    !options.reviewPolicy ||
    !options.reviewModel
  ) {
    return null;
  }
  if (snapshot.kind === "pull_request") {
    if (!snapshot.pull || !validPullMetadata(snapshot.pull)) return null;
  } else if (snapshot.pull !== null) {
    return null;
  }
  const itemStateDigest = reviewStructuralItemStateDigest({
    titleDigest: snapshot.titleDigest,
    bodyDigest: snapshot.bodyDigest,
    state: snapshot.state,
    locked: snapshot.locked,
    author: snapshot.author,
    authorAssociation: snapshot.authorAssociation,
    labels: snapshot.labels,
    comments: snapshot.comments,
  });
  if (!itemStateDigest) return null;
  const recordWithoutFingerprint = {
    version: REVIEW_STRUCTURAL_CACHE_VERSION,
    kind: snapshot.kind,
    sourceRevision: sourceRevision(snapshot),
    itemStateDigest,
    activityUpdatedAt: snapshot.activityUpdatedAt,
    relationSensitive: snapshot.relationSensitive,
    targetHeadSha: snapshot.targetHeadSha,
    pullHeadSha: snapshot.pull?.headSha ?? null,
    pullStateDigest: snapshot.pull ? reviewStructuralPullStateDigest(snapshot.pull) : null,
    reviewPolicy: options.reviewPolicy,
    reviewModel: options.reviewModel,
  } satisfies Omit<ReviewStructuralRecord, "fingerprint">;
  if (snapshot.pull && !recordWithoutFingerprint.pullStateDigest) return null;
  return {
    ...recordWithoutFingerprint,
    fingerprint: recordFingerprint(recordWithoutFingerprint),
  };
}

export function validReviewStructuralRecord(
  record: ReviewStructuralRecord | null,
): record is ReviewStructuralRecord {
  if (!record) return false;
  if (
    record.version !== REVIEW_STRUCTURAL_CACHE_VERSION ||
    !DIGEST_PATTERN.test(record.fingerprint) ||
    !DIGEST_PATTERN.test(record.sourceRevision) ||
    !DIGEST_PATTERN.test(record.itemStateDigest) ||
    !validTimestamp(record.activityUpdatedAt) ||
    typeof record.relationSensitive !== "boolean" ||
    !SHA_PATTERN.test(record.targetHeadSha) ||
    !record.reviewPolicy ||
    !record.reviewModel
  ) {
    return false;
  }
  if (record.kind === "pull_request") {
    if (
      !record.pullHeadSha ||
      !SHA_PATTERN.test(record.pullHeadSha) ||
      !record.pullStateDigest ||
      !DIGEST_PATTERN.test(record.pullStateDigest)
    ) {
      return false;
    }
  } else if (record.pullHeadSha !== null || record.pullStateDigest !== null) {
    return false;
  }
  const { fingerprint: _, ...recordWithoutFingerprint } = record;
  return fingerprintMatches(recordFingerprint(recordWithoutFingerprint), record.fingerprint);
}

export function reviewStructuralRecordAtLeastAsFresh(
  record: ReviewStructuralRecord | null,
  observedUpdatedAt: string | undefined,
): record is ReviewStructuralRecord {
  const recordUpdatedAtMs = timestampMs(record?.activityUpdatedAt);
  const observedUpdatedAtMs = timestampMs(observedUpdatedAt);
  return (
    validReviewStructuralRecord(record) &&
    recordUpdatedAtMs !== null &&
    observedUpdatedAtMs !== null &&
    recordUpdatedAtMs >= observedUpdatedAtMs
  );
}

export function reviewStructuralRecordMatchesObservedUpdate(
  record: ReviewStructuralRecord | null,
  observedUpdatedAt: string | undefined,
): record is ReviewStructuralRecord {
  const recordUpdatedAtMs = timestampMs(record?.activityUpdatedAt);
  const observedUpdatedAtMs = timestampMs(observedUpdatedAt);
  return (
    validReviewStructuralRecord(record) &&
    recordUpdatedAtMs !== null &&
    observedUpdatedAtMs !== null &&
    recordUpdatedAtMs === observedUpdatedAtMs
  );
}

export function reviewStructuralRecordMatchesHydratedItem(
  record: ReviewStructuralRecord | null,
  itemStateDigest: string | undefined,
): record is ReviewStructuralRecord {
  return (
    validReviewStructuralRecord(record) &&
    typeof itemStateDigest === "string" &&
    DIGEST_PATTERN.test(itemStateDigest) &&
    record.itemStateDigest === itemStateDigest
  );
}

export function reviewStructuralRecordMatchesHydratedPull(
  record: ReviewStructuralRecord | null,
  pull: ReviewStructuralPullState | null,
): record is ReviewStructuralRecord {
  if (!validReviewStructuralRecord(record) || record.kind !== "pull_request" || !pull) return false;
  const digest = reviewStructuralPullStateDigest(pull);
  return digest !== null && record.pullStateDigest === digest;
}

export function reviewStructuralRecordsDescribeSameVerdictInput(
  anchor: ReviewStructuralRecord | null,
  current: ReviewStructuralRecord | null,
): current is ReviewStructuralRecord {
  return (
    validReviewStructuralRecord(anchor) &&
    reviewStructuralRecordAtLeastAsFresh(current, anchor.activityUpdatedAt) &&
    anchor.kind === current.kind &&
    anchor.sourceRevision === current.sourceRevision &&
    anchor.itemStateDigest === current.itemStateDigest &&
    anchor.relationSensitive === current.relationSensitive &&
    anchor.targetHeadSha === current.targetHeadSha &&
    anchor.pullHeadSha === current.pullHeadSha &&
    anchor.pullStateDigest === current.pullStateDigest &&
    anchor.reviewPolicy === current.reviewPolicy &&
    anchor.reviewModel === current.reviewModel
  );
}

function fingerprintMatches(expected: string, actual: string): boolean {
  return expected === actual;
}

function timestampMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function activityCoveredByReview(
  prior: ReviewStructuralRecord,
  current: ReviewStructuralRecord,
  review: ReviewStructuralPriorReview,
): boolean {
  if (current.activityUpdatedAt === prior.activityUpdatedAt) return true;
  const priorActivity = timestampMs(prior.activityUpdatedAt);
  const currentActivity = timestampMs(current.activityUpdatedAt);
  const latestOwnedSync = Math.max(
    timestampMs(review.reviewCommentSyncedAt) ?? -Infinity,
    timestampMs(review.labelsSyncedAt) ?? -Infinity,
  );
  return (
    priorActivity !== null &&
    currentActivity !== null &&
    Number.isFinite(latestOwnedSync) &&
    currentActivity >= priorActivity &&
    currentActivity <= latestOwnedSync
  );
}

export function reviewStructuralCacheProbeDecision(
  options: ReviewStructuralCacheProbeOptions,
): ReviewStructuralCacheDecision {
  if (options.explicitDispatch) return { hit: false, reason: "explicit_dispatch" };
  if (options.maintainerRequest) return { hit: false, reason: "maintainer_request" };
  if (!options.coordinationEnabled) return { hit: false, reason: "coordination_disabled" };
  const review = options.review;
  if (!review) return { hit: false, reason: "missing_review" };
  if (review.reviewStatus !== "complete") return { hit: false, reason: "incomplete_review" };
  if (!review.itemSourceRevision || !DIGEST_PATTERN.test(review.itemSourceRevision)) {
    return { hit: false, reason: "missing_lease_revision" };
  }
  if (review.decision !== "keep_open" || review.lastFullReviewDecision !== "keep_open") {
    return { hit: false, reason: "non_keep_open_verdict" };
  }
  if (review.reviewPolicy !== options.reviewPolicy) {
    return { hit: false, reason: "policy_changed" };
  }
  if (review.reviewModel !== options.reviewModel) {
    return { hit: false, reason: "model_changed" };
  }
  const lastFullReviewAt = timestampMs(review.lastFullReviewAt);
  const now = options.now ?? Date.now();
  if (
    lastFullReviewAt === null ||
    lastFullReviewAt > now ||
    now - lastFullReviewAt >= REVIEW_STRUCTURAL_CACHE_MAX_AGE_DAYS * DAY_MS
  ) {
    return { hit: false, reason: "stale_review" };
  }
  return { hit: true, reason: "hit" };
}

export function reviewStructuralCacheDecision(
  options: ReviewStructuralCacheProbeOptions & {
    priorRecord: ReviewStructuralRecord | null;
    currentRecord: ReviewStructuralRecord | null;
  },
): ReviewStructuralCacheDecision {
  const probeDecision = reviewStructuralCacheProbeDecision(options);
  if (!probeDecision.hit) return probeDecision;
  const review = options.review!;
  const prior = options.priorRecord;
  const current = options.currentRecord;
  if (!validReviewStructuralRecord(prior) || !validReviewStructuralRecord(current)) {
    return { hit: false, reason: "missing_or_invalid_record" };
  }
  if (
    prior.reviewPolicy !== options.reviewPolicy ||
    current.reviewPolicy !== options.reviewPolicy
  ) {
    return { hit: false, reason: "policy_changed" };
  }
  if (prior.reviewModel !== options.reviewModel || current.reviewModel !== options.reviewModel) {
    return { hit: false, reason: "model_changed" };
  }
  if (prior.kind !== current.kind) return { hit: false, reason: "item_kind_changed" };
  if (prior.sourceRevision !== current.sourceRevision) {
    return { hit: false, reason: "source_changed" };
  }
  if (!activityCoveredByReview(prior, current, review)) {
    return { hit: false, reason: "activity_changed" };
  }
  if (current.relationSensitive) {
    return { hit: false, reason: "relation_context_present" };
  }
  if (prior.targetHeadSha !== current.targetHeadSha) {
    return { hit: false, reason: "target_changed" };
  }
  if (prior.pullHeadSha !== current.pullHeadSha) {
    return { hit: false, reason: "pull_head_changed" };
  }
  return { hit: true, reason: "hit" };
}
