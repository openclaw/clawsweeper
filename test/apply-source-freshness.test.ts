import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  itemSourceRevisionSha256ForTest,
  renderReviewStartStatusComment,
} from "../dist/clawsweeper.js";
import { createApplySourceFreshness } from "../dist/clawsweeper-apply-source-freshness.js";
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

function sourceFreshness(options: {
  comments: Comment[];
  itemUpdatedAt?: string;
  receiptMatches?: boolean;
  completeIdentity?: boolean;
  isCloseProposal?: boolean;
}) {
  const timestampMs = (value: unknown) => {
    const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : null;
  };
  const record = (value: unknown) =>
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return createApplySourceFreshness(
    {
      asRecord: record,
      CLAWSWEEPER_BOT_AUTHORS: new Set(["clawsweeper", "clawsweeper[bot]"]),
      commentBody: (comment: unknown) => record(comment).body as string | undefined,
      commentId: (comment: unknown) => record(comment).id as number | undefined,
      commentUpdatedAt: (comment: unknown) => record(comment).updated_at as string | undefined,
      // A same-head review whose activity receipt fails must never be rescued by this probe.
      contextHasNonAutomationActivityAfter: () => true,
      fetchIssueReviewComments: () => {
        throw new Error("acknowledgement witness must reuse the apply comment read");
      },
      freshPullRequestReviewHead: () => true,
      frontMatterValue: () => undefined,
      itemSnapshotHash: () => "snapshot",
      login: (user: unknown) => record(user).login as string | undefined,
      recordedLabelSyncCoversUpdate: () => false,
      reviewStartLeaseOwner: () => null,
      stringOrUndefined: (value: unknown) => (typeof value === "string" ? value : undefined),
      timestampMs,
    } as never,
    {
      action: "proposed_close",
      comments: options.comments,
      completeReviewActivityReceiptMatches: () => options.receiptMatches ?? true,
      currentItemContext: () => ({ issue: {}, comments: [], timeline: [] }),
      currentState: () => ({
        isCloseProposal: options.isCloseProposal ?? true,
        markdown: "---\ntype: pull_request\n---\n",
        storedUpdatedAt: reviewSnapshotAt,
      }),
      existingReviewComment: {
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
      markdownBeforeApplyDecisionMutations: "---\ntype: pull_request\n---\n",
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

for (const scenario of ["acknowledgement only", "human comment under acknowledgement"] as const) {
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
      const head = "head-sha";
      const leaseOwner = "github-run-36365080254-1";
      const leaseCommentId = 5861600942;
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
          updated_at: "2026-05-01T01:00:00Z",
          user: { login: "clawsweeper[bot]" },
          body: reviewed.comment,
        },
        {
          ...acknowledgement(),
          html_url: `https://github.com/openclaw/openclaw/pull/${number}#issuecomment-5351727124`,
          created_at: "2026-08-20T05:22:53Z",
        },
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
        ...(scenario === "human comment under acknowledgement"
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
          itemUpdatedAt: acknowledgementCompleteAt,
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
      if (scenario === "acknowledgement only") {
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
