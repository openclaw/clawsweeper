import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { hydratePrLists } from "../../../dist/pr-hydration-snapshot.js";

const repo = "openclaw/clawsweeper";
const number = 97;
const editedCommentId = 3255775240;

function runGh(args) {
  return JSON.parse(
    execFileSync("gh", args, {
      encoding: "utf8",
      env: { ...process.env, GH_PAGER: "cat", NO_COLOR: "1" },
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

const pull = runGh(["api", `repos/${repo}/pulls/${number}`]);
assert.match(pull.updated_at ?? "", /^\d{4}-\d{2}-\d{2}T/);
assert.match(pull.head?.sha ?? "", /^[0-9a-f]{40}$/);
assert.ok(Number.isSafeInteger(pull.commits) && pull.commits > 0);
assert.ok(Number.isSafeInteger(pull.review_comments) && pull.review_comments > 0);

const editedProbe = runGh([
  "api",
  `repos/${repo}/pulls/${number}/comments?since=2026-05-18T00%3A38%3A30Z&per_page=100`,
]);
assert.ok(editedProbe.some((comment) => comment.id === editedCommentId));

const transport = [];
const fetchList = (kind, path) => {
  transport.push({ kind, path });
  const items = runGh(["api", `${path}${path.includes("?") ? "&" : "?"}per_page=100`]);
  return { items, total: items.length, hydrated: items.length, truncated: false };
};
const fetchAll = (kind, path) => {
  transport.push({ kind, path });
  return runGh(["api", `${path}${path.includes("?") ? "&" : "?"}per_page=100`]);
};

const cold = hydratePrLists({
  repo,
  number,
  pullUpdatedAt: pull.updated_at,
  headSha: pull.head.sha,
  commitCount: pull.commits,
  reviewCommentCount: pull.review_comments,
  prior: null,
  fetchCommits: () => fetchList("commit_list", `repos/${repo}/pulls/${number}/commits`),
  fetchReviewComments: () =>
    fetchList("review_comment_list", `repos/${repo}/pulls/${number}/comments`),
  fetchCompleteReviewComments: () =>
    fetchAll("review_comment_list", `repos/${repo}/pulls/${number}/comments`),
  fetchReviewCommentsSince: () => {
    throw new Error("cold hydration must not use since");
  },
  now: () => "2026-08-13T04:00:00Z",
});
assert.ok(cold.snapshot);
assert.equal(transport.length, 2);

transport.length = 0;
for (let unchanged = 0; unchanged < 3; unchanged += 1) {
  const reused = hydratePrLists({
    repo,
    number,
    pullUpdatedAt: pull.updated_at,
    headSha: pull.head.sha,
    commitCount: pull.commits,
    reviewCommentCount: pull.review_comments,
    prior: cold.snapshot,
    fetchCommits: () => {
      throw new Error("unchanged commit list must be reused");
    },
    fetchReviewComments: () => {
      throw new Error("unchanged review comments must be reused");
    },
    fetchCompleteReviewComments: () => {
      throw new Error("unchanged complete comments must be reused");
    },
    fetchReviewCommentsSince: () => {
      throw new Error("unchanged review comments must not use since");
    },
  });
  assert.equal(reused.commitsReused, true);
  assert.equal(reused.reviewCommentsReused, true);
}
assert.equal(transport.length, 0);

const metadataChanged = hydratePrLists({
  repo,
  number,
  pullUpdatedAt: "2026-08-13T04:00:01Z",
  headSha: pull.head.sha,
  commitCount: pull.commits,
  reviewCommentCount: pull.review_comments,
  prior: cold.snapshot,
  fetchCommits: () => {
    throw new Error("unchanged commit identity must be reused");
  },
  fetchReviewComments: () => {
    throw new Error("safe delta should not require a full read");
  },
  fetchCompleteReviewComments: () => {
    throw new Error("safe delta should retain the complete snapshot");
  },
  fetchReviewCommentsSince: (since) =>
    fetchAll(
      "review_comment_list_since",
      `repos/${repo}/pulls/${number}/comments?since=${encodeURIComponent(since)}`,
    ),
});
assert.equal(metadataChanged.reviewCommentsIncremental, true);

const forced = hydratePrLists({
  repo,
  number,
  pullUpdatedAt: "2026-08-13T04:00:02Z",
  headSha: "f".repeat(40),
  commitCount: pull.commits,
  reviewCommentCount: pull.review_comments,
  prior: cold.snapshot,
  fetchCommits: () => fetchList("commit_list", `repos/${repo}/pulls/${number}/commits`),
  fetchReviewComments: () =>
    fetchList("review_comment_list", `repos/${repo}/pulls/${number}/comments`),
  fetchCompleteReviewComments: () =>
    fetchAll("review_comment_list", `repos/${repo}/pulls/${number}/comments`),
  fetchReviewCommentsSince: () => {
    throw new Error("changed head must not use since");
  },
});
assert.equal(forced.commitsReused, false);
assert.equal(forced.reviewCommentsIncremental, false);

assert.deepEqual(
  transport.map((entry) => entry.kind),
  ["review_comment_list_since", "commit_list", "review_comment_list"],
);

console.log(
  JSON.stringify(
    {
      repository: repo,
      public_fixture: {
        pull: number,
        head_sha: pull.head.sha,
        commits: pull.commits,
        review_comments: pull.review_comments,
        edited_comment_probe: editedCommentId,
      },
      unchanged_prs: 3,
      changed_prs: 2,
      before: { list_reads: 10 },
      after: { list_reads: 3, unchanged_list_reads: 0 },
      changed_input_equality: {
        metadata_change_comments:
          JSON.stringify(metadataChanged.completeReviewComments) ===
          JSON.stringify(cold.completeReviewComments),
        force_push_commits:
          JSON.stringify(forced.commits.items) === JSON.stringify(cold.commits.items),
        force_push_comments:
          JSON.stringify(forced.completeReviewComments) ===
          JSON.stringify(cold.completeReviewComments),
      },
      transport,
      result: "PASS",
    },
    null,
    2,
  ),
);
