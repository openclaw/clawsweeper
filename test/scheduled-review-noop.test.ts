import assert from "node:assert/strict";
import test from "node:test";
import { classifyScheduledReviewNoop } from "../dist/scheduled-review-noop.js";
import { itemSourceRevisionSha256 } from "../dist/clawsweeper-source-revision.js";

const issue = {
  number: 41,
  title: "Unchanged issue",
  body: "Original body",
  state: "open",
  locked: false,
  updated_at: "2026-08-09T21:12:38Z",
  labels: [
    { name: "status: ready for maintainer look" },
    { name: "mantis: telegram-visible-proof" },
  ],
};
function fixture(overrides: Record<string, unknown> = {}, reporter = "reporter") {
  const humanComments = [
    {
      id: 1,
      user: { login: reporter },
      body: "Human evidence",
      created_at: "2026-08-09T19:00:00Z",
      updated_at: "2026-08-09T19:00:00Z",
    },
  ];
  const revision = itemSourceRevisionSha256(issue, humanComments);
  const botComment = {
    id: 2,
    user: { login: "clawsweeper[bot]" },
    body: `Review unchanged\n\n<!-- clawsweeper-review-version item=41 reviewed_at=2026-08-09T21:12:33Z sha=na source_revision=${revision} lease_owner=old lease_comment_id=2 v=1 -->`,
    created_at: "2026-08-09T20:00:00Z",
    updated_at: "2026-08-09T21:12:33Z",
  };
  return {
    decision: { sourceAction: "scheduled_hot_intake", sourceUpdatedAt: issue.updated_at },
    issue,
    comments: [...humanComments, botComment],
    ...overrides,
  };
}

test("claim-time classifier accepts trusted owned activity through timestamp settling", () => {
  assert.deepEqual(classifyScheduledReviewNoop(fixture()), {
    noop: true,
    reason: "trusted_owned_activity_only",
  });
  const boundaryIssue = { ...issue, updated_at: "2026-08-09T21:13:03Z" };
  const boundary = fixture({
    issue: boundaryIssue,
    decision: { sourceAction: "scheduled_hot_intake", sourceUpdatedAt: boundaryIssue.updated_at },
  });
  assert.equal(classifyScheduledReviewNoop(boundary).noop, true);
  const outsideIssue = { ...issue, updated_at: "2026-08-09T21:13:04Z" };
  const outside = fixture({
    issue: outsideIssue,
    decision: { sourceAction: "scheduled_hot_intake", sourceUpdatedAt: outsideIssue.updated_at },
  });
  assert.equal(classifyScheduledReviewNoop(outside).noop, false);
});
test("claim-time classifier recognizes owned activity when a commenter login has capitals", () => {
  // Production: esp-openclaw-node#67 (commenter DonnieFi) and clawhub#3439 (MoltyCel) got a
  // full review every hour. The guard recomputed the revision with lowercased logins, so it
  // never matched the revision the review comment recorded.
  assert.deepEqual(classifyScheduledReviewNoop(fixture({}, "DonnieFi")), {
    noop: true,
    reason: "trusted_owned_activity_only",
  });
});
test("claim-time classifier preserves human and mixed source changes", () => {
  const current = fixture();
  assert.equal(
    classifyScheduledReviewNoop({
      ...current,
      comments: [
        ...current.comments,
        {
          id: 3,
          user: { login: "maintainer" },
          body: "New human evidence",
          updated_at: "2026-08-09T21:12:35Z",
        },
      ],
    }).noop,
    false,
  );
});
test("claim-time classifier preserves protected and human-owned label changes", () => {
  for (const label of [
    "proof: override",
    "clawsweeper:human-review",
    "clawsweeper:manual-only",
    "clawsweeper:bulk-filed",
    "release-blocker",
  ]) {
    const current = fixture();
    const changedIssue = { ...current.issue, labels: [...current.issue.labels, { name: label }] };
    assert.equal(
      classifyScheduledReviewNoop({ ...current, issue: changedIssue }).noop,
      false,
      label,
    );
  }
});
test("claim-time classifier is conservative for source drift and missing receipts", () => {
  const current = fixture();
  assert.equal(
    classifyScheduledReviewNoop({
      ...current,
      decision: { ...current.decision, sourceUpdatedAt: "2026-08-09T21:12:37Z" },
    }).noop,
    false,
  );
  assert.equal(
    classifyScheduledReviewNoop({ ...current, comments: current.comments.slice(0, 1) }).noop,
    false,
  );
});

test("claim-time classifier requires an exact durable pull request head", () => {
  const current = fixture();
  const pull = { ...current.issue, pull_request: { url: "https://api.github.test/pulls/41" } };
  const comments = current.comments.map((comment) =>
    comment.id === 2 ? { ...comment, body: comment.body.replace("sha=na", "sha=abc123") } : comment,
  );
  assert.equal(classifyScheduledReviewNoop({ ...current, issue: pull, comments }).noop, false);
  assert.equal(
    classifyScheduledReviewNoop({ ...current, issue: pull, comments, liveHeadSha: "def456" }).noop,
    false,
  );
  assert.equal(
    classifyScheduledReviewNoop({ ...current, issue: pull, comments, liveHeadSha: "abc123" }).noop,
    true,
  );
});

test("planner does not offer an issue whose only post-review activity is ClawSweeper's own write", async () => {
  // Production: clawhub issues were offered every ~15 minutes (scheduled no-op
  // runs) and fully re-reviewed every ~2 hours, because each review's own
  // comment edit and label sync moved updated_at past reviewed_at.
  const { createReviewPlanningInventory } =
    await import("../dist/clawsweeper-review-planning-inventory.js");
  const repo = "openclaw/clawhub";
  const { issue: liveIssue, comments } = fixture();
  const now = Date.parse("2026-08-09T22:30:00Z");
  const item = {
    repo,
    number: 41,
    kind: "issue",
    labels: [],
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: liveIssue.updated_at,
  };
  const review = {
    reviewStatus: "complete",
    reviewedAt: "2026-08-09T21:12:33Z",
    itemUpdatedAt: "2026-08-09T21:12:20Z",
  };
  const index = { byKey: new Map([[`${repo}#41`, review]]) };
  const inventoryFor = (live: unknown, liveComments: unknown[]) => {
    const reads: string[] = [];
    const inventory = createReviewPlanningInventory({
      targetRepo: () => repo,
      ghJson: (args: string[]) => {
        reads.push(args[1]!);
        return args[1]!.includes("/comments") ? [liveComments] : live;
      },
      ghJsonLines: () => [],
      normalizeAuthorAssociation: () => "CONTRIBUTOR",
    } as never);
    return { inventory, reads };
  };

  const owned = inventoryFor(liveIssue, comments);
  assert.equal(owned.inventory.dueCandidate(item, "/nonexistent", now, undefined, index), null);
  assert.equal(owned.reads.length, 2);

  const human = {
    id: 3,
    user: { login: "reporter" },
    body: "Still broken on 2.1",
    created_at: "2026-08-09T21:12:38Z",
    updated_at: "2026-08-09T21:12:38Z",
  };
  const changed = inventoryFor(liveIssue, [...comments, human]);
  assert.equal(
    changed.inventory.dueCandidate(item, "/nonexistent", now, undefined, index)?.item.number,
    41,
  );

  // Normal cadence still applies: a week later the issue is offered without
  // any ownership read, so target-branch drift keeps being reviewed.
  const later = inventoryFor(liveIssue, comments);
  assert.equal(
    later.inventory.dueCandidate(item, "/nonexistent", now + 8 * 86_400_000, undefined, index)?.item
      .number,
    41,
  );
  assert.equal(later.reads.length, 0);
});

test("hot intake does not re-offer a cadence-due issue whose only activity is ClawSweeper's own write", async () => {
  // Production: esp-openclaw-node#92 reached queue revision 364. It was due on its normal
  // cadence, so the activity-only planner check never ran, and every hot pass offered it.
  // Each offer ended as a trusted_owned_activity_only no-op that recorded nothing.
  const { createReviewPlanningInventory } =
    await import("../dist/clawsweeper-review-planning-inventory.js");
  const { createReviewPlanningHotIntake } =
    await import("../dist/clawsweeper-review-planning-hot-intake.js");
  const repo = "openclaw/esp-openclaw-node";
  const { issue: liveIssue, comments } = fixture({}, "DonnieFi");
  const now = Date.parse("2026-08-20T00:00:00Z");
  const item = {
    repo,
    number: 41,
    kind: "issue",
    labels: [],
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: liveIssue.updated_at,
  };
  const review = { reviewStatus: "complete", reviewedAt: "2026-08-09T21:12:33Z" };
  const hotIntakeFor = (liveComments: unknown[]) => {
    const dependencies = {
      targetRepo: () => repo,
      ghJson: (args: string[]) => (args[1]!.includes("/comments") ? [liveComments] : liveIssue),
      ghJsonLines: () => [],
      normalizeAuthorAssociation: () => "CONTRIBUTOR",
    } as never;
    const inventory = createReviewPlanningInventory(dependencies);
    return createReviewPlanningHotIntake({ ...(dependencies as object), ...inventory } as never);
  };

  const owned = hotIntakeFor(comments);
  assert.equal(owned.shouldSkipScheduledHotIntakeExactReview(item, review, now, undefined), true);

  const human = {
    id: 3,
    user: { login: "DonnieFi" },
    body: "Still broken on 2.1",
    created_at: "2026-08-09T21:12:38Z",
    updated_at: "2026-08-09T21:12:38Z",
  };
  const changed = hotIntakeFor([...comments, human]);
  assert.equal(
    changed.shouldSkipScheduledHotIntakeExactReview(item, review, now, undefined),
    false,
  );

  // Production: esp-openclaw-node#92 and clawscan#69 kept getting hot offers after #2209
  // because their reviews predate the current review policy. The claim-time no-op ignores
  // policy, so each offer was a no-op and the policy re-review never happened.
  const stalePolicy = { ...review, reviewPolicy: "old-policy" };
  assert.equal(
    owned.shouldSkipScheduledHotIntakeExactReview(item, stalePolicy, now, "new-policy"),
    true,
  );
  assert.equal(
    changed.shouldSkipScheduledHotIntakeExactReview(item, stalePolicy, now, "new-policy"),
    false,
  );
  // Backfill still offers it, so the policy re-review happens there as a real review.
  const backfill = createReviewPlanningInventory({
    targetRepo: () => repo,
    ghJson: (args: string[]) => (args[1]!.includes("/comments") ? [comments] : liveIssue),
    ghJsonLines: () => [],
    normalizeAuthorAssociation: () => "CONTRIBUTOR",
  } as never);
  const index = { byKey: new Map([[`${repo}#41`, stalePolicy]]) };
  assert.equal(
    backfill.dueCandidate(item, "/nonexistent", now, "new-policy", index)?.item.number,
    41,
  );

  // Never reviewed: a hot offer stays eligible without any ownership read.
  assert.equal(owned.shouldSkipScheduledHotIntakeExactReview(item, null, now, undefined), false);
});
