import assert from "node:assert/strict";
import test from "node:test";
import { filterReviewComments } from "../dist/clawsweeper-review-comments.js";
import {
  itemSourceRevisionSha256ForTest,
  renderReviewStartStatusComment,
} from "../dist/clawsweeper.js";

const context = {
  isClawSweeperComment(value: unknown): boolean {
    const comment = value as { user?: { login?: string } };
    return ["clawsweeper", "clawsweeper[bot]", "openclaw-clawsweeper[bot]"].includes(
      comment.user?.login || "",
    );
  },
  reviewCommentBodyDigest: (body: string): string => body,
};

test("automatic receipt and review-progress comments do not enter review context", () => {
  const issue = { title: "Review publication", body: "Same source", labels: [] };
  const sourceRevision = itemSourceRevisionSha256ForTest(issue, []);
  for (const login of ["clawsweeper", "clawsweeper[bot]", "openclaw-clawsweeper[bot]"]) {
    for (const body of [
      "<!-- clawsweeper-pr-ack:opened item=42 -->\nClawSweeper picked this up.",
      "<!-- clawsweeper-review-progress:start -->\nReview in progress.",
      "<!-- clawsweeper-review-progress:start -->\nBlocked; no review verdict was produced.",
      "Review completed.\n<!-- clawsweeper-review-progress:end -->",
      "Queued.\n<!-- clawsweeper-command-status:42:re_review:fixture -->",
      "Acknowledged.\n<!-- clawsweeper-command-ack:42:fixture -->",
      renderReviewStartStatusComment({
        number: 42,
        kind: "pull_request",
        title: issue.title,
        headSha: "a".repeat(40),
        startedAt: "2026-09-09T19:53:58Z",
        leaseOwner: "fixture-review",
      }),
    ]) {
      const comment = { id: 123, user: { login }, body, updated_at: "2026-09-09T19:53:58Z" };
      assert.deepEqual(filterReviewComments([comment], 42, context), {
        included: [],
        filtered: 1,
      });
      assert.equal(itemSourceRevisionSha256ForTest(issue, [comment]), sourceRevision);
      assert.equal(
        itemSourceRevisionSha256ForTest(issue, [
          {
            ...comment,
            body: `${body}\nUpdated status.`,
            updated_at: "2026-09-09T19:57:00Z",
          },
        ]),
        sourceRevision,
      );
    }
  }
});

test("human discussion quoting automatic status markers remains in review context", () => {
  const human = {
    user: { login: "contributor" },
    body:
      "Why is <!-- clawsweeper-review-progress:start --> still blocked? " +
      "The receipt is <!-- clawsweeper-pr-ack:opened item=42 -->.",
  };
  assert.deepEqual(filterReviewComments([human], 42, context), {
    included: [human],
    filtered: 0,
  });
  assert.notEqual(
    itemSourceRevisionSha256ForTest({}, [human]),
    itemSourceRevisionSha256ForTest({}, []),
  );
});

test("substantive unmarked bot discussion is not removed with automatic status noise", () => {
  const discussion = {
    user: { login: "clawsweeper[bot]" },
    body: "The regression reproduces when the lease is superseded during publication.",
  };
  assert.deepEqual(filterReviewComments([discussion], 42, context), {
    included: [discussion],
    filtered: 0,
  });
});
