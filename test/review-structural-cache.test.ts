import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createReviewStructuralRecord,
  reviewStructuralActivitiesForTest,
  reviewStructuralCacheDecision,
  reviewStructuralCacheProbeDecision,
  reviewStructuralQuery,
  reviewStructuralRecordAtLeastAsFresh,
  reviewStructuralRecordFromGraphql,
  reviewStructuralRecordMatchesHydratedItem,
  reviewStructuralRecordMatchesHydratedPull,
  reviewStructuralRecordMatchesObservedUpdate,
  reviewStructuralRecordsDescribeSameVerdictInput,
  type ReviewStructuralRecord,
  type ReviewStructuralSnapshot,
} from "../dist/review-structural-cache.js";

const NOW = Date.parse("2026-07-12T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const TARGET_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const BASE_SHA = "c".repeat(40);
const CHECKS_DIGEST = "d".repeat(64);

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function issueSnapshot(
  overrides: Partial<ReviewStructuralSnapshot> = {},
): ReviewStructuralSnapshot {
  return {
    repo: "openclaw/openclaw",
    number: 123,
    kind: "issue",
    nodeId: "I_kwDOIssue",
    author: "contributor",
    authorAssociation: "CONTRIBUTOR",
    titleDigest: digest("title"),
    bodyDigest: digest("body"),
    state: "OPEN",
    locked: false,
    labels: ["bug"],
    labelsTruncated: false,
    activityUpdatedAt: "2026-07-10T10:00:00Z",
    comments: [
      {
        id: "IC_comment_1",
        updatedAt: "2026-07-10T09:00:00Z",
        author: "contributor",
        authorAssociation: "CONTRIBUTOR",
        state: null,
        commitSha: null,
        bodyDigest: digest("comment"),
      },
    ],
    commentsTruncated: false,
    timeline: [{ type: "CrossReferencedEvent", id: "CE_1", source: "PR_kwDO1" }],
    timelineTruncated: false,
    relationSensitive: false,
    targetHeadSha: TARGET_SHA,
    latestReleaseTag: "v1.0.0",
    latestReleaseSha: TARGET_SHA,
    pull: null,
    ...overrides,
  };
}

function pullSnapshot(overrides: Partial<ReviewStructuralSnapshot> = {}): ReviewStructuralSnapshot {
  return {
    ...issueSnapshot(),
    kind: "pull_request",
    nodeId: "PR_kwDOPull",
    pull: {
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      draft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      additions: 10,
      deletions: 2,
      changedFiles: 3,
      commitCount: 2,
      checksDigest: CHECKS_DIGEST,
      reviews: [
        {
          id: "PRR_review_1",
          updatedAt: "2026-07-10T08:00:00Z",
          author: "maintainer",
          authorAssociation: "MEMBER",
          state: "APPROVED",
          commitSha: HEAD_SHA,
          bodyDigest: digest("review"),
        },
      ],
      reviewsTruncated: false,
      reviewThreads: [
        {
          id: "PRRT_thread_1",
          isResolved: true,
          comments: [
            {
              id: "PRRC_comment_1",
              updatedAt: "2026-07-10T08:30:00Z",
              author: "maintainer",
              authorAssociation: "MEMBER",
              state: null,
              commitSha: null,
              bodyDigest: digest("thread comment"),
            },
          ],
          commentsTruncated: false,
        },
      ],
      reviewThreadsTruncated: false,
    },
    ...overrides,
  };
}

function record(
  snapshot: ReviewStructuralSnapshot = issueSnapshot(),
  options: { policy?: string; model?: string } = {},
): ReviewStructuralRecord {
  const result = createReviewStructuralRecord(snapshot, {
    reviewPolicy: options.policy ?? "policy-1",
    reviewModel: options.model ?? "gpt-5.6",
  });
  assert.ok(result);
  return result;
}

function review(overrides = {}) {
  return {
    reviewStatus: "complete",
    decision: "keep_open",
    lastFullReviewAt: new Date(NOW - DAY_MS).toISOString(),
    lastFullReviewDecision: "keep_open",
    reviewPolicy: "policy-1",
    reviewModel: "gpt-5.6",
    itemSourceRevision: digest("full item source"),
    reviewCommentSyncedAt: "2026-07-10T10:01:00Z",
    labelsSyncedAt: "2026-07-10T10:02:00Z",
    ...overrides,
  };
}

function decision(overrides = {}) {
  const priorRecord = record();
  return reviewStructuralCacheDecision({
    review: review(),
    priorRecord,
    currentRecord: priorRecord,
    reviewPolicy: "policy-1",
    reviewModel: "gpt-5.6",
    explicitDispatch: false,
    maintainerRequest: false,
    coordinationEnabled: true,
    now: NOW,
    ...overrides,
  });
}

function graphqlConnection(nodes: unknown[] = []) {
  return { pageInfo: { hasPreviousPage: false, hasNextPage: false }, nodes };
}

function graphqlNode(kind: "issue" | "pull_request") {
  const common = {
    id: kind === "issue" ? "I_kwDOIssue" : "PR_kwDOPull",
    number: 123,
    title: "Title",
    body: "Body",
    state: "OPEN",
    locked: false,
    updatedAt: "2026-07-10T10:00:00Z",
    author: { login: "contributor" },
    authorAssociation: "CONTRIBUTOR",
    labels: graphqlConnection([{ name: "bug" }]),
    comments: graphqlConnection([
      {
        id: "IC_human",
        updatedAt: "2026-07-10T09:00:00Z",
        body: "No related item",
        author: { login: "contributor" },
        authorAssociation: "CONTRIBUTOR",
      },
      {
        id: "IC_bot",
        updatedAt: "2026-07-10T09:30:00Z",
        body: "Automated status",
        author: { login: "clawsweeper[bot]" },
        authorAssociation: "NONE",
      },
    ]),
    timelineItems: graphqlConnection([
      { __typename: "AssignedEvent", id: "AE_human" },
      {
        __typename: "IssueComment",
        id: "IC_bot_timeline",
        updatedAt: "2026-07-10T09:30:00Z",
        body: "Automated status",
        author: { login: "clawsweeper[bot]" },
      },
      {
        __typename: "LabeledEvent",
        id: "LE_advisory",
        createdAt: "2026-07-10T09:40:00Z",
        actor: { login: "github-actions[bot]" },
        label: { name: "P2" },
      },
    ]),
  };
  if (kind === "issue") return common;
  return {
    ...common,
    headRefOid: HEAD_SHA,
    baseRefOid: BASE_SHA,
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    commits: { totalCount: 2 },
    reviews: graphqlConnection([
      {
        id: "PRR_review",
        updatedAt: "2026-07-10T08:00:00Z",
        body: "Approved",
        author: { login: "maintainer" },
        authorAssociation: "MEMBER",
        state: "APPROVED",
        commit: { oid: HEAD_SHA },
      },
    ]),
    reviewThreads: graphqlConnection([
      {
        id: "PRRT_thread",
        isResolved: true,
        comments: graphqlConnection([
          {
            id: "PRRC_comment",
            updatedAt: "2026-07-10T08:30:00Z",
            body: "No related item",
            author: { login: "maintainer" },
            authorAssociation: "MEMBER",
          },
        ]),
      },
    ]),
  };
}

function graphqlRecord(kind: "issue" | "pull_request", node = graphqlNode(kind)) {
  return reviewStructuralRecordFromGraphql({
    response: {
      data: {
        repository: {
          [kind === "issue" ? "issue" : "pullRequest"]: node,
        },
      },
    },
    repo: "openclaw/openclaw",
    number: 123,
    kind,
    targetHeadSha: TARGET_SHA,
    latestReleaseTag: "v1.0.0",
    latestReleaseSha: TARGET_SHA,
    pullChecksDigest: kind === "pull_request" ? CHECKS_DIGEST : null,
    reviewPolicy: "policy-1",
    reviewModel: "gpt-5.6",
    ignoreAuthor: (author) => author.toLowerCase() === "clawsweeper[bot]",
    ignoreLabel: (label) => label.toLowerCase() === "p2",
  });
}

test("unchanged completed keep-open issue hits the structural cache", () => {
  assert.deepEqual(decision(), { hit: true, reason: "hit" });
});

test("cheap eligibility rejects ineligible reviews before structural records are needed", () => {
  const eligible = {
    review: review(),
    reviewPolicy: "policy-1",
    reviewModel: "gpt-5.6",
    explicitDispatch: false,
    maintainerRequest: false,
    coordinationEnabled: true,
    now: NOW,
  };
  assert.deepEqual(reviewStructuralCacheProbeDecision(eligible), {
    hit: true,
    reason: "hit",
  });
  assert.equal(
    reviewStructuralCacheProbeDecision({ ...eligible, review: null }).reason,
    "missing_review",
  );
  assert.equal(
    reviewStructuralCacheProbeDecision({ ...eligible, explicitDispatch: true }).reason,
    "explicit_dispatch",
  );
  assert.equal(
    reviewStructuralCacheProbeDecision({
      ...eligible,
      review: review({ lastFullReviewAt: new Date(NOW - 14 * DAY_MS).toISOString() }),
    }).reason,
    "stale_review",
  );
});

test("structural probes cannot undercut a newer observed item generation", () => {
  const current = record();
  assert.equal(reviewStructuralRecordAtLeastAsFresh(current, "2026-07-10T10:00:00Z"), true);
  assert.equal(reviewStructuralRecordAtLeastAsFresh(current, "2026-07-10T10:00:01Z"), false);
  assert.equal(reviewStructuralRecordMatchesObservedUpdate(current, "2026-07-10T10:00:00Z"), true);
  assert.equal(reviewStructuralRecordMatchesObservedUpdate(current, "2026-07-10T09:59:59Z"), false);
});

test("verdict fingerprints may advance owned activity but not semantic input", () => {
  const anchor = record();
  const ownedActivityAdvance = record(issueSnapshot({ activityUpdatedAt: "2026-07-10T10:01:00Z" }));
  assert.equal(reviewStructuralRecordsDescribeSameVerdictInput(anchor, ownedActivityAdvance), true);
  const changedInput = record(
    issueSnapshot({
      activityUpdatedAt: "2026-07-10T10:02:00Z",
      titleDigest: digest("changed title"),
    }),
  );
  assert.equal(reviewStructuralRecordsDescribeSameVerdictInput(anchor, changedInput), false);
  assert.equal(
    reviewStructuralRecordsDescribeSameVerdictInput(ownedActivityAdvance, anchor),
    false,
  );
});

test("GraphQL decoder builds bounded issue and PR records", () => {
  const issueRecord = graphqlRecord("issue");
  const pullRecord = graphqlRecord("pull_request");
  assert.ok(issueRecord);
  assert.equal(issueRecord.kind, "issue");
  assert.equal(issueRecord.pullHeadSha, null);
  assert.ok(issueRecord.itemStateDigest);
  assert.ok(pullRecord);
  assert.equal(pullRecord.kind, "pull_request");
  assert.equal(pullRecord.pullHeadSha, HEAD_SHA);
  assert.ok(pullRecord.pullStateDigest);
});

test("structural records canonicalize GitHub App login suffixes", () => {
  const graphql = record(
    issueSnapshot({
      author: "dependabot",
      comments: [
        {
          ...issueSnapshot().comments[0],
          author: "third-party-app",
        },
      ],
    }),
  );
  const rest = record(
    issueSnapshot({
      author: "dependabot[bot]",
      comments: [
        {
          ...issueSnapshot().comments[0],
          author: "third-party-app[bot]",
        },
      ],
    }),
  );
  assert.equal(graphql.itemStateDigest, rest.itemStateDigest);
  assert.equal(graphql.sourceRevision, rest.sourceRevision);
});

test("GraphQL decoder fails closed on truncated metadata", () => {
  const issue = graphqlNode("issue");
  const comments = {
    ...issue.comments,
    pageInfo: { hasPreviousPage: true, hasNextPage: false },
  };
  assert.equal(graphqlRecord("issue", { ...issue, comments }), null);
});

test("GraphQL decoder requires the queried pagination boundary", () => {
  const issue = graphqlNode("issue");
  assert.equal(
    graphqlRecord("issue", {
      ...issue,
      labels: {
        pageInfo: { hasPreviousPage: false },
        nodes: [{ name: "bug" }],
      },
    }),
    null,
  );
  assert.equal(
    graphqlRecord("issue", {
      ...issue,
      comments: {
        pageInfo: { hasNextPage: false },
        nodes: issue.comments.nodes,
      },
    }),
    null,
  );
});

test("GraphQL decoder rejects incomplete relation targets", () => {
  const issue = graphqlNode("issue");
  assert.equal(
    graphqlRecord("issue", {
      ...issue,
      timelineItems: graphqlConnection([
        {
          __typename: "CrossReferencedEvent",
          id: "CE_incomplete",
          createdAt: "2026-07-10T09:45:00Z",
          source: null,
        },
      ]),
    }),
    null,
  );
});

test("GraphQL decoder tracks human timeline events and ignores owned churn", () => {
  const node = graphqlNode("issue");
  const full = graphqlRecord("issue", node);
  assert.ok(full);
  const timeline = node.timelineItems.nodes;
  const withoutIgnored = graphqlRecord("issue", {
    ...node,
    timelineItems: graphqlConnection([timeline[0]]),
  });
  assert.ok(withoutIgnored);
  assert.equal(full.sourceRevision, withoutIgnored.sourceRevision);
  const withoutHuman = graphqlRecord("issue", {
    ...node,
    timelineItems: graphqlConnection(timeline.slice(1)),
  });
  assert.ok(withoutHuman);
  assert.notEqual(full.sourceRevision, withoutHuman.sourceRevision);
});

test("changed human comment metadata forces hydration", () => {
  const priorRecord = record();
  const currentRecord = record(
    issueSnapshot({
      comments: [
        {
          id: "IC_comment_1",
          updatedAt: "2026-07-11T09:00:00Z",
          author: "contributor",
          authorAssociation: "CONTRIBUTOR",
          state: null,
          commitSha: null,
          bodyDigest: digest("comment"),
        },
      ],
    }),
  );
  assert.equal(decision({ priorRecord, currentRecord }).reason, "source_changed");
});

test("unexplained activity after owned sync forces hydration", () => {
  const priorRecord = record();
  const currentRecord = record(issueSnapshot({ activityUpdatedAt: "2026-07-10T10:03:00Z" }));
  assert.equal(decision({ priorRecord, currentRecord }).reason, "activity_changed");
});

test("owned comment or label synchronization may explain metadata-only activity", () => {
  const priorRecord = record();
  const currentRecord = record(issueSnapshot({ activityUpdatedAt: "2026-07-10T10:02:00Z" }));
  assert.equal(decision({ priorRecord, currentRecord }).hit, true);
});

test("changed target head forces issue hydration", () => {
  const priorRecord = record();
  const currentRecord = record(issueSnapshot({ targetHeadSha: "d".repeat(40) }));
  assert.equal(decision({ priorRecord, currentRecord }).reason, "target_changed");
});

test("relation-sensitive records always force full hydration", () => {
  const relationRecord = record(issueSnapshot({ relationSensitive: true }));
  assert.deepEqual(decision({ priorRecord: relationRecord, currentRecord: relationRecord }), {
    hit: false,
    reason: "relation_context_present",
  });
});

test("GraphQL decoder detects explicit and external relation sources", () => {
  const explicit = graphqlRecord("issue", {
    ...graphqlNode("issue"),
    body: "See #456 for the shared failure.",
  });
  assert.ok(explicit);
  assert.equal(explicit.relationSensitive, true);

  const external = reviewStructuralRecordFromGraphql({
    response: {
      data: {
        repository: {
          issue: graphqlNode("issue"),
        },
      },
    },
    repo: "openclaw/openclaw",
    number: 123,
    kind: "issue",
    targetHeadSha: TARGET_SHA,
    latestReleaseTag: "v1.0.0",
    latestReleaseSha: TARGET_SHA,
    reviewPolicy: "policy-1",
    reviewModel: "gpt-5.6",
    ignoreAuthor: (author) => author.toLowerCase() === "clawsweeper[bot]",
    ignoreLabel: (label) => label.toLowerCase() === "p2",
    externalRelationSensitive: true,
  });
  assert.ok(external);
  assert.equal(external.relationSensitive, true);
});

test("changed author association or release identity forces hydration", () => {
  const priorRecord = record();
  assert.equal(
    decision({
      priorRecord,
      currentRecord: record(issueSnapshot({ authorAssociation: "MEMBER" })),
    }).reason,
    "source_changed",
  );
  assert.equal(
    decision({
      priorRecord,
      currentRecord: record(
        issueSnapshot({
          latestReleaseTag: "v1.1.0",
          latestReleaseSha: "d".repeat(40),
        }),
      ),
    }).reason,
    "source_changed",
  );
});

test("changed review policy or model forces hydration", () => {
  assert.equal(decision({ reviewPolicy: "policy-2" }).reason, "policy_changed");
  assert.equal(decision({ reviewModel: "gpt-next" }).reason, "model_changed");
});

test("explicit dispatch and maintainer requests always hydrate", () => {
  assert.equal(decision({ explicitDispatch: true }).reason, "explicit_dispatch");
  assert.equal(decision({ maintainerRequest: true }).reason, "maintainer_request");
});

test("disabled coordination and missing lease revisions force hydration", () => {
  assert.equal(decision({ coordinationEnabled: false }).reason, "coordination_disabled");
  assert.equal(
    decision({ review: review({ itemSourceRevision: undefined }) }).reason,
    "missing_lease_revision",
  );
});

test("stale completed reviews force hydration", () => {
  assert.equal(
    decision({
      review: review({ lastFullReviewAt: new Date(NOW - 14 * DAY_MS).toISOString() }),
    }).reason,
    "stale_review",
  );
});

test("future completed review timestamps force hydration", () => {
  assert.equal(
    decision({
      review: review({ lastFullReviewAt: new Date(NOW + DAY_MS).toISOString() }),
    }).reason,
    "stale_review",
  );
});

test("old reports without structural fields force hydration", () => {
  assert.equal(decision({ priorRecord: null }).reason, "missing_or_invalid_record");
});

test("failed and close reviews always hydrate", () => {
  assert.equal(
    decision({ review: review({ reviewStatus: "failed" }) }).reason,
    "incomplete_review",
  );
  assert.equal(decision({ review: review({ decision: "close" }) }).reason, "non_keep_open_verdict");
  assert.equal(
    decision({ review: review({ lastFullReviewDecision: "close" }) }).reason,
    "non_keep_open_verdict",
  );
});

test("PR records require unchanged PR source and head", () => {
  const priorRecord = record(pullSnapshot());
  const changedHead = pullSnapshot({
    pull: {
      ...pullSnapshot().pull!,
      headSha: "d".repeat(40),
    },
  });
  const currentRecord = record(changedHead);
  assert.equal(decision({ priorRecord, currentRecord }).reason, "pull_head_changed");
});

test("changed PR review state forces hydration", () => {
  const priorRecord = record(pullSnapshot());
  const currentRecord = record(
    pullSnapshot({
      pull: {
        ...pullSnapshot().pull!,
        reviews: [
          {
            ...pullSnapshot().pull!.reviews[0]!,
            state: "CHANGES_REQUESTED",
          },
        ],
      },
    }),
  );
  assert.equal(decision({ priorRecord, currentRecord }).reason, "source_changed");
});

test("changed PR merge-state status forces hydration", () => {
  const priorRecord = record(pullSnapshot());
  const currentRecord = record(
    pullSnapshot({
      pull: {
        ...pullSnapshot().pull!,
        mergeStateStatus: "BLOCKED",
      },
    }),
  );
  assert.equal(decision({ priorRecord, currentRecord }).reason, "source_changed");
});

test("same-second human comment edits change the structural source revision", () => {
  const node = graphqlNode("issue");
  const original = graphqlRecord("issue", node);
  const edited = graphqlRecord("issue", {
    ...node,
    comments: graphqlConnection([
      {
        ...node.comments.nodes[0],
        body: "Edited without a timestamp advance",
      },
      node.comments.nodes[1],
    ]),
  });
  assert.ok(original);
  assert.ok(edited);
  assert.notEqual(original.sourceRevision, edited.sourceRevision);
});

test("post-hydration anchors reject same-second semantic edits", () => {
  const node = graphqlNode("issue");
  const hydrated = graphqlRecord("issue", node);
  const edited = graphqlRecord("issue", {
    ...node,
    body: "Edited without a timestamp advance",
  });
  assert.ok(hydrated);
  assert.ok(edited);
  assert.equal(reviewStructuralRecordMatchesObservedUpdate(edited, node.updatedAt), true);
  assert.equal(reviewStructuralRecordMatchesHydratedItem(edited, hydrated.itemStateDigest), false);
});

test("same-second review edits change the structural source revision", () => {
  const node = graphqlNode("pull_request");
  const original = graphqlRecord("pull_request", node);
  const review = node.reviews.nodes[0];
  assert.ok(review);
  const edited = graphqlRecord("pull_request", {
    ...node,
    reviews: graphqlConnection([
      {
        ...review,
        body: "Approved after another pass",
      },
    ]),
  });
  assert.ok(original);
  assert.ok(edited);
  assert.notEqual(original.sourceRevision, edited.sourceRevision);
});

test("same-second review-thread edits change the structural source revision", () => {
  const node = graphqlNode("pull_request");
  const original = graphqlRecord("pull_request", node);
  const thread = node.reviewThreads.nodes[0];
  assert.ok(thread);
  const comment = thread.comments.nodes[0];
  assert.ok(comment);
  const edited = graphqlRecord("pull_request", {
    ...node,
    reviewThreads: graphqlConnection([
      {
        ...thread,
        comments: graphqlConnection([
          {
            ...comment,
            body: "Edited without a timestamp advance",
          },
        ]),
      },
    ]),
  });
  assert.ok(original);
  assert.ok(edited);
  assert.notEqual(original.sourceRevision, edited.sourceRevision);
});

test("hydration anchors reject same-second PR review and timeline edits", () => {
  const node = graphqlNode("pull_request");
  const beforeHydration = graphqlRecord("pull_request", node);
  const review = node.reviews.nodes[0];
  assert.ok(beforeHydration);
  assert.ok(review);
  const reviewEdited = graphqlRecord("pull_request", {
    ...node,
    reviews: graphqlConnection([{ ...review, body: "Edited during hydration" }]),
  });
  assert.ok(reviewEdited);
  assert.equal(reviewStructuralRecordMatchesObservedUpdate(reviewEdited, node.updatedAt), true);
  assert.equal(
    reviewStructuralRecordsDescribeSameVerdictInput(beforeHydration, reviewEdited),
    false,
  );

  const timelineEdited = graphqlRecord("pull_request", {
    ...node,
    timelineItems: graphqlConnection([
      ...node.timelineItems.nodes,
      {
        __typename: "LabeledEvent",
        id: "LE_human",
        createdAt: node.updatedAt,
        actor: { login: "maintainer" },
        label: { name: "needs-review" },
      },
    ]),
  });
  assert.ok(timelineEdited);
  assert.equal(reviewStructuralRecordMatchesObservedUpdate(timelineEdited, node.updatedAt), true);
  assert.equal(
    reviewStructuralRecordsDescribeSameVerdictInput(beforeHydration, timelineEdited),
    false,
  );
});

test("hydrated pull state must match the complete structural PR state", () => {
  const current = record(pullSnapshot());
  const hydrated = {
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    draft: false,
    mergeable: true,
    mergeStateStatus: "clean",
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    commitCount: 2,
  };
  assert.equal(reviewStructuralRecordMatchesHydratedPull(current, hydrated), true);
  assert.equal(
    reviewStructuralRecordMatchesHydratedPull(current, {
      ...hydrated,
      baseSha: "d".repeat(40),
    }),
    false,
  );
  assert.equal(
    reviewStructuralRecordMatchesHydratedPull(current, {
      ...hydrated,
      mergeStateStatus: "blocked",
    }),
    false,
  );
  assert.equal(
    reviewStructuralRecordMatchesHydratedPull(current, {
      ...hydrated,
      mergeable: false,
    }),
    false,
  );
});

test("changed PR check state forces hydration", () => {
  const priorRecord = record(pullSnapshot());
  const currentRecord = record(
    pullSnapshot({
      pull: {
        ...pullSnapshot().pull!,
        checksDigest: "e".repeat(64),
      },
    }),
  );
  assert.equal(decision({ priorRecord, currentRecord }).reason, "source_changed");
});

test("changed maintainer proof override forces hydration", () => {
  const priorRecord = record(pullSnapshot());
  const currentRecord = record(
    pullSnapshot({
      labels: [...pullSnapshot().labels, "proof: override"],
    }),
  );
  assert.equal(decision({ priorRecord, currentRecord }).reason, "source_changed");
});

test("semantic context revision excludes code-volume and commit-count churn", () => {
  const prior = record(pullSnapshot());
  const reformatted = record(
    pullSnapshot({
      pull: {
        ...pullSnapshot().pull!,
        additions: 40,
        deletions: 30,
        changedFiles: 4,
        commitCount: 5,
      },
    }),
  );

  assert.notEqual(prior.sourceRevision, reformatted.sourceRevision);
  assert.equal(prior.contextRevision, reformatted.contextRevision);
});

test("semantic context revision includes review and readiness state", () => {
  const prior = record(pullSnapshot());
  const changedReview = record(
    pullSnapshot({
      pull: {
        ...pullSnapshot().pull!,
        reviews: [
          {
            ...pullSnapshot().pull!.reviews[0]!,
            state: "CHANGES_REQUESTED",
          },
        ],
      },
    }),
  );
  const changedReadiness = record(
    pullSnapshot({
      pull: {
        ...pullSnapshot().pull!,
        mergeStateStatus: "BLOCKED",
      },
    }),
  );
  const changedChecks = record(
    pullSnapshot({
      pull: {
        ...pullSnapshot().pull!,
        checksDigest: "e".repeat(64),
      },
    }),
  );

  assert.notEqual(prior.contextRevision, changedReview.contextRevision);
  assert.notEqual(prior.contextRevision, changedReadiness.contextRevision);
  assert.notEqual(prior.contextRevision, changedChecks.contextRevision);
});

test("issue and PR records cannot be reused across kinds", () => {
  assert.equal(
    decision({ priorRecord: record(), currentRecord: record(pullSnapshot()) }).reason,
    "item_kind_changed",
  );
});

test("truncated comments, timeline, reviews, and threads cannot seed the cache", () => {
  assert.equal(
    createReviewStructuralRecord(issueSnapshot({ commentsTruncated: true }), {
      reviewPolicy: "policy-1",
      reviewModel: "gpt-5.6",
    }),
    null,
  );
  assert.equal(
    createReviewStructuralRecord(issueSnapshot({ timelineTruncated: true }), {
      reviewPolicy: "policy-1",
      reviewModel: "gpt-5.6",
    }),
    null,
  );
  assert.equal(
    createReviewStructuralRecord(
      pullSnapshot({
        pull: { ...pullSnapshot().pull!, reviewThreadsTruncated: true },
      }),
      { reviewPolicy: "policy-1", reviewModel: "gpt-5.6" },
    ),
    null,
  );
});

test("metadata probes inspect relation links without persisting comment or review bodies", () => {
  const issueQuery = reviewStructuralQuery("issue");
  const pullQuery = reviewStructuralQuery("pull_request");

  assert.match(issueQuery, /comments\(last: 100\)/);
  assert.match(issueQuery, /CrossReferencedEvent/);
  assert.match(issueQuery, /comments\(last: 100\)[\s\S]*?\bbody\b/);
  assert.match(pullQuery, /headRefOid/);
  assert.match(pullQuery, /reviewThreads\(last: 100\)/);
  assert.match(pullQuery, /reviewThreads\(last: 100\)[\s\S]*?\bbody\b/);
});

test("PR structural records require a complete check-state digest", () => {
  const node = graphqlNode("pull_request");
  assert.equal(
    reviewStructuralRecordFromGraphql({
      response: { data: { repository: { pullRequest: node } } },
      repo: "openclaw/openclaw",
      number: 123,
      kind: "pull_request",
      targetHeadSha: TARGET_SHA,
      latestReleaseTag: "v1.0.0",
      latestReleaseSha: TARGET_SHA,
      pullChecksDigest: null,
      reviewPolicy: "policy-1",
      reviewModel: "gpt-5.6",
      ignoreAuthor: () => false,
      ignoreLabel: () => false,
    }),
    null,
  );
});

test("metadata probes ignore ClawSweeper comments but fail closed on malformed entries", () => {
  const result = reviewStructuralActivitiesForTest(
    {
      pageInfo: { hasPreviousPage: false },
      nodes: [
        {
          id: "bot-comment",
          updatedAt: "2026-07-10T10:00:00Z",
          body: "Automated status",
          author: { login: "ClawSweeper[bot]" },
          authorAssociation: "NONE",
        },
        {
          id: "human-comment",
          updatedAt: "2026-07-10T10:01:00Z",
          body: "No related item",
          author: { login: "maintainer" },
          authorAssociation: "MEMBER",
        },
      ],
    },
    ["clawsweeper[bot]"],
  );
  assert.equal(result.truncated, false);
  assert.deepEqual(result.activities, [
    {
      id: "human-comment",
      updatedAt: "2026-07-10T10:01:00Z",
      author: "maintainer",
      authorAssociation: "MEMBER",
      state: null,
      commitSha: null,
      bodyDigest: digest("No related item"),
    },
  ]);
  assert.equal(
    reviewStructuralActivitiesForTest({
      pageInfo: { hasPreviousPage: false },
      nodes: [{ id: "missing-timestamp", author: { login: "maintainer" } }],
    }).truncated,
    true,
  );
});
