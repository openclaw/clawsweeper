import assert from "node:assert/strict";
import test from "node:test";
import {
  newerDurableReviewTupleVerified,
  staleReviewCommentSyncReason,
} from "../dist/clawsweeper-review-comment-state.js";
import type { ItemContext } from "../dist/clawsweeper-types.js";

const earlier = "2026-05-01T00:00:00Z";
const later = "2026-05-02T00:00:00Z";

type Scenario = {
  reportAt?: string;
  liveAt?: string;
  reportOwner?: string;
  liveOwner?: string;
  leaseId?: string;
  liveRevision?: string;
  liveLease?: "missing" | "different-owner" | "different-id" | "different-revision";
};

function tuple(kind: "issue" | "pull_request", scenario: Scenario = {}) {
  const revision = "a".repeat(kind === "issue" ? 64 : 40);
  const liveRevision = scenario.liveRevision ?? revision;
  const sourceRevision = kind === "issue" ? revision : "d".repeat(64);
  const leaseId = scenario.leaseId ?? "9100";
  const report = [
    "---",
    "number: 42",
    `type: ${kind}`,
    `reviewed_at: ${scenario.reportAt ?? later}`,
    `review_lease_owner: ${scenario.reportOwner ?? "current-owner"}`,
    `review_lease_comment_id: ${leaseId}`,
    `pull_head_sha: ${kind === "pull_request" ? revision : "unknown"}`,
    `item_source_revision: ${sourceRevision}`,
    "---",
  ].join("\n");
  const comment = {
    user: { login: "clawsweeper[bot]" },
    updated_at: scenario.liveAt ?? earlier,
    body: [
      "Codex review: previous review.",
      ...(kind === "pull_request"
        ? [`<!-- clawsweeper-review-state:blocked item=42 sha=${liveRevision} v=1 -->`]
        : []),
      `<!-- clawsweeper-review-version item=42 reviewed_at=${scenario.liveAt ?? earlier} sha=${kind === "pull_request" ? liveRevision : "na"} source_revision=${sourceRevision} lease_owner=${scenario.liveOwner ?? "previous-owner"} lease_comment_id=${leaseId} v=1 -->`,
      "<!-- clawsweeper-review item=42 -->",
    ].join("\n"),
  };
  const context = { pullRequest: { head: { sha: liveRevision } } } as ItemContext;
  const lease =
    scenario.liveLease === "missing"
      ? null
      : {
          owner:
            scenario.liveLease === "different-owner"
              ? "other-owner"
              : (scenario.reportOwner ?? "current-owner"),
          commentId: scenario.liveLease === "different-id" ? Number(leaseId) + 1 : Number(leaseId),
          headSha: scenario.liveLease === "different-revision" ? "c".repeat(40) : revision,
        };
  return { report, comment, context, lease };
}

for (const kind of ["issue", "pull_request"] as const) {
  test(`${kind}: a later owner can publish a newer report using the same command lease id`, () => {
    const { report, comment, context, lease } = tuple(kind);
    assert.equal(staleReviewCommentSyncReason(report, comment, 42, context, lease), null);
    assert.equal(newerDurableReviewTupleVerified(report, comment, 42), false);
  });

  for (const [name, scenario] of [
    ["equal timestamps", { reportAt: earlier, liveAt: earlier }],
    ["unknown report owner", { reportOwner: "unknown" }],
    ["unknown durable owner", { liveOwner: "unknown" }],
    ["unsafe lease id", { leaseId: "9007199254740992" }],
    ["missing report timestamp", { reportAt: "unknown" }],
    ["missing original lease with a later clock", { liveLease: "missing" }],
    ["another owner of the original lease", { liveLease: "different-owner" }],
    ["a newly acquired mutation lease", { liveLease: "different-id" }],
    ["a different leased revision", { liveLease: "different-revision" }],
  ] satisfies [string, Scenario][]) {
    test(`${kind}: a reused lease cannot bypass ${name}`, () => {
      const { report, comment, context, lease } = tuple(kind, scenario);
      assert.match(
        staleReviewCommentSyncReason(report, comment, 42, context, lease) ?? "",
        /live durable review tuple/,
      );
      assert.equal(newerDurableReviewTupleVerified(report, comment, 42), false);
    });
  }

  test(`${kind}: a complete later review supersedes an old report with the reused lease`, () => {
    const { report, comment, context, lease } = tuple(kind, { reportAt: earlier, liveAt: later });
    assert.match(
      staleReviewCommentSyncReason(report, comment, 42, context, lease) ?? "",
      /live durable review tuple/,
    );
    assert.equal(newerDurableReviewTupleVerified(report, comment, 42), true);
  });

  test(`${kind}: later review time cannot repair an invalid report identity`, () => {
    for (const scenario of [
      { reportOwner: "unknown" },
      { liveOwner: "unknown" },
      { leaseId: "9007199254740992" },
      { reportAt: "unknown" },
    ]) {
      const { report, comment } = tuple(kind, { reportAt: earlier, liveAt: later, ...scenario });
      assert.equal(newerDurableReviewTupleVerified(report, comment, 42), false);
    }
  });

  test(`${kind}: a greater lease id still supersedes with a skewed review clock`, () => {
    const { report, comment } = tuple(kind);
    comment.body = comment.body.replace("lease_comment_id=9100", "lease_comment_id=9200");
    assert.equal(newerDurableReviewTupleVerified(report, comment, 42), true);
  });

  for (const [name, change] of [
    ["same owner", (body: string) => body.replace("previous-owner", "current-owner")],
    ["missing source", (body: string) => body.replace(/ source_revision=\S+/, "")],
    [
      "different source",
      (body: string) => body.replace(/source_revision=\S+/, "source_revision=" + "e".repeat(64)),
    ],
    [
      "duplicate version",
      (body: string) => body.replace(/(<!-- clawsweeper-review-version[^\n]+\n)/, "$1$1"),
    ],
    ["invalid timestamp", (body: string) => body.replace(later, "invalid")],
    ...(kind === "pull_request"
      ? [
          [
            "inconsistent state",
            (body: string) => body.replace("sha=" + "a".repeat(40), "sha=" + "b".repeat(40)),
          ] as const,
        ]
      : []),
  ] as const) {
    test(`${kind}: reused-lease supersession rejects ${name}`, () => {
      const { report, comment } = tuple(kind, { reportAt: earlier, liveAt: later });
      comment.body = change(comment.body);
      assert.equal(newerDurableReviewTupleVerified(report, comment, 42), false);
    });
  }
}

test("a reused PR lease cannot bypass a changed reviewed head", () => {
  const { report, comment, context, lease } = tuple("pull_request", {
    liveRevision: "b".repeat(40),
    reportAt: earlier,
    liveAt: later,
  });
  assert.match(
    staleReviewCommentSyncReason(report, comment, 42, context, lease) ?? "",
    /live durable review comment/,
  );
  assert.equal(newerDurableReviewTupleVerified(report, comment, 42), false);
});
