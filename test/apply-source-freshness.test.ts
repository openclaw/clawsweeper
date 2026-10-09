import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  itemSourceRevisionSha256ForTest,
  renderReviewStartStatusComment,
} from "../dist/clawsweeper.js";
import {
  createApplySourceFreshness,
  OWNED_LEASE_RELEASE_RECEIPT_WINDOW_MS,
} from "../dist/clawsweeper-apply-source-freshness.js";
import { completeActivityContextSymbol } from "../dist/clawsweeper-types.js";
import {
  promotionGhMock,
  readText,
  reportWithSyncedReviewComment,
  runApplyDecisionsForTest,
  tmpPrefix,
  verifiedImplementationPullRequestReport,
  withMockGh,
} from "./helpers.ts";

// Shape of openclaw/openclaw#126549: the exact review snapshots the PR right after its
// acknowledgement comment is marked "in progress", then marks it "complete" before publication.
const number = 126549;
const reviewSnapshotAt = "2026-09-28T01:13:43Z";
const acknowledgementCompleteAt = "2026-09-28T01:17:50Z";
const acknowledgementBody = [
  `<!-- clawsweeper-pr-ack:opened item=${number} -->`,
  "🦞👀",
  "ClawSweeper picked this up.",
  "",
  "<!-- clawsweeper-review-progress:start -->",
  "### ClawSweeper review complete",
  "<!-- clawsweeper-review-progress:end -->",
].join("\n");

type Comment = { id: number; user: { login: string }; updated_at: string; body: string };

function acknowledgement(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 5351727124,
    user: { login: "clawsweeper[bot]" },
    updated_at: acknowledgementCompleteAt,
    body: acknowledgementBody,
    ...overrides,
  };
}

// The review generation's own tuple, recorded in its report and its durable review comment.
const leaseOwner = "github-run-36365080254-1";
const leaseCommentId = 5861600942;
const reviewedAt = "2026-09-28T01:17:40.000Z";
const reviewedSourceRevision = "a".repeat(64);
const reviewedReport = [
  "---",
  "type: pull_request",
  `reviewed_at: ${reviewedAt}`,
  `item_source_revision: ${reviewedSourceRevision}`,
  `review_lease_owner: ${leaseOwner}`,
  `review_lease_comment_id: ${leaseCommentId}`,
  "---",
  "",
].join("\n");
// Shape of openclaw/openclaw#143911: the producer syncs the durable comment, keeps the close
// proposal open, then releases (deletes) its review lease, which is the latest item update.
const durableSyncedAt = "2026-09-28T01:18:20Z";
const leaseReleasedAt = "2026-09-28T01:18:23Z";

function durableReview(
  overrides: { version?: Record<string, string>; comment?: Partial<Comment> } = {},
): Comment {
  const version = {
    item: String(number),
    reviewed_at: reviewedAt,
    sha: "f".repeat(40),
    source_revision: reviewedSourceRevision,
    lease_owner: leaseOwner,
    lease_comment_id: String(leaseCommentId),
    v: "1",
    ...overrides.version,
  };
  return {
    id: 5351817173,
    user: { login: "clawsweeper[bot]" },
    updated_at: durableSyncedAt,
    body: [
      "Codex review: kept open.",
      `<!-- clawsweeper-review-version ${Object.entries(version)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ")} -->`,
      `<!-- clawsweeper-review item=${number} -->`,
    ].join("\n"),
    ...overrides.comment,
  };
}

function releasedLeaseFreshness(
  options: Partial<Parameters<typeof sourceFreshness>[0]> = {},
): ReturnType<typeof sourceFreshness> {
  return sourceFreshness({
    comments: [acknowledgement(), durableReview()],
    existingReviewComment: durableReview(),
    itemUpdatedAt: leaseReleasedAt,
    nonAutomationActivityAfterSnapshot: false,
    ...options,
  });
}

function sourceFreshness(options: {
  comments: Comment[];
  itemUpdatedAt?: string;
  receiptMatches?: boolean;
  completeIdentity?: boolean;
  isCloseProposal?: boolean;
  existingReviewComment?: Comment;
  // Non-automation comment, review comment, or timeline event after the review snapshot.
  nonAutomationActivityAfterSnapshot?: boolean;
  // The activity read is truncated and has no complete hydration.
  truncatedActivity?: boolean;
  labelSyncRecorded?: boolean;
  timeline?: { event: string; actor: string; createdAt: string; label?: string }[];
}) {
  const record = (value: unknown) =>
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const context = { issue: {}, comments: [], timeline: [] } as Record<PropertyKey, unknown>;
  if (options.timeline)
    context[completeActivityContextSymbol] = {
      comments: [],
      timeline: options.timeline,
      pullReviewComments: [],
    };
  return createApplySourceFreshness(
    {
      CLAWSWEEPER_BOT_AUTHORS: new Set(["clawsweeper", "clawsweeper[bot]"]),
      commentBody: (comment: unknown) => record(comment).body as string | undefined,
      commentId: (comment: unknown) => record(comment).id as number | undefined,
      commentUpdatedAt: (comment: unknown) => record(comment).updated_at as string | undefined,
      // Like the real dependency, truncation counts as activity unless the caller opts out.
      contextHasNonAutomationActivityAfter: (
        _context: unknown,
        _afterMs: number,
        activity?: { truncationCountsAsActivity?: boolean },
      ) =>
        options.nonAutomationActivityAfterSnapshot ??
        (options.truncatedActivity === true && (activity?.truncationCountsAsActivity ?? true)),
      fetchIssueReviewComments: () => {
        throw new Error("acknowledgement witness must reuse the apply comment read");
      },
      freshPullRequestReviewHead: () => true,
      itemSnapshotHash: () => "snapshot",
      recordedLabelSyncCoversUpdate: () => options.labelSyncRecorded ?? false,
      reviewStartLeaseOwner: () => null,
    } as never,
    {
      action: "proposed_close",
      comments: options.comments,
      completeReviewActivityReceiptMatches: () => options.receiptMatches ?? true,
      currentItemContext: () => context,
      currentState: () => ({
        isCloseProposal: options.isCloseProposal ?? true,
        markdown: "---\ntype: pull_request\n---\n",
        storedUpdatedAt: reviewSnapshotAt,
      }),
      existingReviewComment: options.existingReviewComment ?? {
        id: 5351817173,
        user: { login: "clawsweeper[bot]" },
        updated_at: "2026-09-22T08:19:47Z",
      },
      item: {
        repo: "openclaw/openclaw",
        number,
        kind: "pull_request",
        updatedAt: options.itemUpdatedAt ?? acknowledgementCompleteAt,
        labels: [],
      },
      leaseComments: [],
      markdownBeforeApplyDecisionMutations: reviewedReport,
      number,
      reportLabelsBeforeApply: [],
      reportReviewLeaseCommentId: 5861600942,
      reportReviewLeaseOwner: "github-run-36365080254-1",
      reviewHasCompleteActivityIdentity: options.completeIdentity ?? true,
      requiresApplyMutationLease: true,
      storedHash: "snapshot",
    } as never,
  );
}

test("own acknowledgement progress edit after the review snapshot is not source drift", () => {
  const freshness = sourceFreshness({ comments: [acknowledgement()] });
  assert.equal(freshness.updatedSinceReview, true);
  assert.equal(freshness.automationOnlyUpdate, true);
  assert.equal(freshness.reviewedSourceFresh(), true);
  assert.equal(freshness.labelSyncFreshEnough(), true);
});

test("acknowledgement edit cannot mask other activity after the review snapshot", () => {
  const stale = [
    // Human comment, title/label edit, PR review, or new head under the same updated_at second.
    { name: "changed activity receipt", options: { receiptMatches: false } },
    // A human managed-label edit is outside the receipt but still visible activity.
    { name: "non-automation activity", options: { nonAutomationActivityAfterSnapshot: true } },
    // Activity after the acknowledgement edit is the latest item update.
    {
      name: "later human comment",
      options: {
        itemUpdatedAt: "2026-09-28T01:17:55Z",
        comments: [
          acknowledgement(),
          {
            id: 5861699002,
            user: { login: "NianJiuZst" },
            updated_at: "2026-09-28T01:17:55Z",
            body: "Still reproduces for me.",
          },
        ],
      },
    },
    {
      name: "marker authored outside ClawSweeper",
      options: { comments: [acknowledgement({ user: { login: "NianJiuZst" } })] },
    },
    {
      name: "marker for another item",
      options: {
        comments: [
          acknowledgement({
            body: acknowledgementBody.replace(`item=${number}`, "item=126550"),
          }),
        ],
      },
    },
    {
      name: "unmarked ClawSweeper status comment",
      options: { comments: [acknowledgement({ body: "ClawSweeper status: review started." })] },
    },
    {
      name: "tuple-less legacy review",
      options: { completeIdentity: false },
    },
  ];
  for (const { name, options } of stale) {
    const freshness = sourceFreshness({ comments: [acknowledgement()], ...options });
    assert.equal(freshness.automationOnlyUpdate, false, name);
    assert.equal(freshness.reviewedSourceFresh(), false, name);
  }
});

test("recorded label sync cannot hide activity behind truncated hydration", () => {
  const labelSync = { comments: [], completeIdentity: false, labelSyncRecorded: true };
  assert.equal(sourceFreshness(labelSync).automationOnlyUpdate, true);
  const truncated = sourceFreshness({ ...labelSync, truncatedActivity: true });
  assert.equal(truncated.automationOnlyUpdate, false);
  assert.equal(truncated.reviewedSourceFresh(), false);
});

test("released review lease after the generation's durable sync is not source drift", () => {
  const freshness = releasedLeaseFreshness();
  assert.equal(freshness.updatedSinceReview, true);
  assert.equal(freshness.automationOnlyUpdate, true);
  assert.equal(freshness.reviewedSourceFresh(), true);
  // The release may follow a later ClawSweeper label edit instead of the durable sync.
  const afterLabel = releasedLeaseFreshness({
    itemUpdatedAt: "2026-09-28T01:19:30Z",
    timeline: [{ event: "labeled", actor: "clawsweeper[bot]", createdAt: "2026-09-28T01:19:28Z" }],
  });
  assert.equal(afterLabel.automationOnlyUpdate, true);
});

test("released review lease receipt cannot mask external or unrecorded activity", () => {
  const windowEnd = new Date(
    Date.parse(durableSyncedAt) + OWNED_LEASE_RELEASE_RECEIPT_WINDOW_MS,
  ).toISOString();
  const pastWindow = new Date(Date.parse(windowEnd) + 1000).toISOString();
  assert.equal(releasedLeaseFreshness({ itemUpdatedAt: windowEnd }).automationOnlyUpdate, true);
  const leaseComment: Comment = {
    id: leaseCommentId,
    user: { login: "clawsweeper[bot]" },
    updated_at: "2026-09-28T01:13:40Z",
    body: `<!-- clawsweeper-review-status:started item=${number} owner=${leaseOwner} --> <!-- clawsweeper-review-lease item=${number} -->`,
  };
  const stale = [
    // Human comment, title/body or non-managed label edit, PR review, or new head.
    { name: "changed activity receipt", options: { receiptMatches: false } },
    // Human managed-label edit or other non-automation timeline activity.
    { name: "non-automation activity", options: { nonAutomationActivityAfterSnapshot: true } },
    { name: "tuple-less legacy review", options: { completeIdentity: false } },
    {
      name: "generation lease still live",
      options: { comments: [acknowledgement(), durableReview(), leaseComment] },
    },
    { name: "update long after the last recorded write", options: { itemUpdatedAt: pastWindow } },
    {
      name: "recorded write newer than the item read",
      options: { itemUpdatedAt: "2026-09-28T01:18:10Z" },
    },
    {
      name: "durable comment synced before the review snapshot",
      options: {
        existingReviewComment: durableReview({ comment: { updated_at: "2026-09-28T01:13:00Z" } }),
        comments: [acknowledgement()],
        itemUpdatedAt: "2026-09-28T01:18:00Z",
      },
    },
    ...(
      [
        ["another lease comment", { lease_comment_id: "5861600943" }],
        ["another lease owner", { lease_owner: "github-run-1-1" }],
        ["another review", { reviewed_at: "2026-09-28T01:17:41.000Z" }],
        ["another source revision", { source_revision: "b".repeat(64) }],
        ["another item", { item: String(number + 1) }],
      ] as const
    ).map(([name, version]) => ({
      name: `durable comment records ${name}`,
      options: { existingReviewComment: durableReview({ version }) },
    })),
    {
      name: "durable comment authored outside ClawSweeper",
      options: {
        existingReviewComment: durableReview({ comment: { user: { login: "NianJiuZst" } } }),
      },
    },
  ];
  for (const { name, options } of stale) {
    const freshness = releasedLeaseFreshness(options);
    assert.equal(freshness.automationOnlyUpdate, false, name);
    assert.equal(freshness.reviewedSourceFresh(), false, name);
  }
});

test("any ClawSweeper-recorded write for the item can account for the latest update", () => {
  const leaseAt = "2026-09-28T01:18:30Z";
  const ownedLease = sourceFreshness({
    itemUpdatedAt: leaseAt,
    comments: [
      acknowledgement(),
      {
        id: 5861600999,
        user: { login: "clawsweeper[bot]" },
        updated_at: leaseAt,
        body: `<!-- clawsweeper-review-status:started item=${number} --> <!-- clawsweeper-review-lease item=${number} -->`,
      },
    ],
  });
  assert.equal(ownedLease.automationOnlyUpdate, true);
  for (const [body, owned] of [
    [`<!-- clawsweeper-issue-implementation-progress:in_progress item=${number} -->`, true],
    [`<!-- clawsweeper-review-status:started item=${number}0 -->`, false],
    [`<!-- not-clawsweeper item=${number} -->`, false],
  ] as const)
    assert.equal(
      sourceFreshness({
        itemUpdatedAt: leaseAt,
        comments: [
          { id: 5861600998, user: { login: "clawsweeper[bot]" }, updated_at: leaseAt, body },
        ],
      }).automationOnlyUpdate,
      owned,
      body,
    );
  const labelAt = "2026-09-28T01:18:31Z";
  const label = (actor: string) =>
    sourceFreshness({
      itemUpdatedAt: labelAt,
      comments: [acknowledgement()],
      timeline: [{ event: "labeled", actor, createdAt: labelAt, label: "P2" }],
    });
  assert.equal(label("clawsweeper[bot]").automationOnlyUpdate, true);
  assert.equal(label("NianJiuZst").automationOnlyUpdate, false);
  for (const blocked of [{ receiptMatches: false }, { nonAutomationActivityAfterSnapshot: true }])
    assert.equal(
      sourceFreshness({
        itemUpdatedAt: labelAt,
        comments: [acknowledgement()],
        timeline: [{ event: "labeled", actor: "clawsweeper[bot]", createdAt: labelAt }],
        ...blocked,
      }).automationOnlyUpdate,
      false,
    );
});

for (const scenario of [
  "acknowledgement only",
  "human comment under acknowledgement",
  // Deferred batch re-apply after the producer synced, kept open, and released its lease.
  "released review lease",
  "human comment under released review lease",
] as const) {
  test(`exact PR close apply after acknowledgement completion: ${scenario}`, () => {
    const root = mkdtempSync(tmpPrefix);
    try {
      const itemsDir = join(root, "items");
      const closedDir = join(root, "closed");
      const plansDir = join(root, "plans");
      const reportPath = join(root, "apply-report.json");
      for (const directory of [itemsDir, closedDir, plansDir])
        mkdirSync(directory, { recursive: true });
      const title = "fix(chat): restore active turns after cursor reconnects";
      const released = scenario.includes("released review lease");
      // The durable comment records its review generation only for an exact PR head.
      const head = released ? "f".repeat(40) : "head-sha";
      const reviewed = reportWithSyncedReviewComment(
        verifiedImplementationPullRequestReport({
          repository: "openclaw/openclaw",
          number,
          type: "pull_request",
          title,
          url: `https://github.com/openclaw/openclaw/pull/${number}`,
          author: "reporter",
          author_association: "CONTRIBUTOR",
          labels: "[]",
          pull_head_sha: head,
          item_updated_at: reviewSnapshotAt,
          item_source_revision: itemSourceRevisionSha256ForTest(
            { title, body: "Stale PR body.", labels: [] },
            [],
          ),
          review_timeline_revision: createHash("sha256").update("[]").digest("hex"),
          review_lease_owner: leaseOwner,
          review_lease_comment_id: String(leaseCommentId),
        }),
        number,
        "implemented_on_main",
      );
      writeFileSync(join(itemsDir, `${number}.md`), reviewed.report);
      const comments = [
        {
          id: 9000 + number,
          html_url: `https://github.com/openclaw/openclaw/pull/${number}#issuecomment-${9000 + number}`,
          created_at: "2026-05-01T01:00:00Z",
          updated_at: released ? durableSyncedAt : "2026-05-01T01:00:00Z",
          user: { login: "clawsweeper[bot]" },
          body: reviewed.comment,
        },
        {
          ...acknowledgement(),
          html_url: `https://github.com/openclaw/openclaw/pull/${number}#issuecomment-5351727124`,
          created_at: "2026-08-20T05:22:53Z",
        },
        ...(released
          ? []
          : [
              {
                id: leaseCommentId,
                html_url: `https://github.com/openclaw/openclaw/pull/${number}#issuecomment-${leaseCommentId}`,
                created_at: "2026-09-28T01:13:40Z",
                updated_at: "2026-09-28T01:13:40Z",
                user: { login: "clawsweeper[bot]" },
                body: renderReviewStartStatusComment({
                  number,
                  kind: "pull_request",
                  title,
                  headSha: head,
                  startedAt: "2026-09-28T01:13:40Z",
                  leaseExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
                  leaseOwner,
                }),
              },
            ]),
        ...(scenario.startsWith("human comment")
          ? [
              {
                id: 5861699001,
                html_url: `https://github.com/openclaw/openclaw/pull/${number}#issuecomment-5861699001`,
                created_at: "2026-09-28T01:16:05Z",
                updated_at: "2026-09-28T01:16:05Z",
                user: { login: "reporter" },
                author_association: "CONTRIBUTOR",
                body: "This still reproduces for me on current main.",
              },
            ]
          : []),
      ];
      withMockGh(
        root,
        promotionGhMock({
          number,
          title,
          labels: [],
          headSha: head,
          itemUpdatedAt: released ? leaseReleasedAt : acknowledgementCompleteAt,
          comment: reviewed.comment,
          comments,
        }),
        () =>
          runApplyDecisionsForTest({
            targetRepo: "openclaw/openclaw",
            itemsDir,
            closedDir,
            plansDir,
            reportPath,
            extraArgs: [
              "--apply-kind",
              "all",
              "--item-number",
              String(number),
              "--dry-run",
              "--event-apply-proof",
              "--exact-event-publication",
            ],
          }),
      );
      const [result] = JSON.parse(readText(reportPath));
      if (!scenario.startsWith("human comment")) {
        // Freshness passes, so the proposal reaches the close gates instead of a drift requeue.
        assert.deepEqual(result, {
          number,
          action: "kept_open",
          reason:
            "implemented-on-main close requires explicit same-repository linked issues for paired closeout",
        });
      } else {
        assert.equal(result.action, "skipped_changed_since_review");
        assert.equal(result.reason, "updated_at changed");
        assert.equal(result.sourceDriftVerified, true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
