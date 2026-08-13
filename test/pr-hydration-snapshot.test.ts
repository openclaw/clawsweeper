import assert from "node:assert/strict";
import test from "node:test";

import {
  hydratePrLists,
  parsePrHydrationSnapshot,
  serializePrHydrationSnapshot,
  type PrHydrationSnapshot,
} from "../dist/pr-hydration-snapshot.js";

const repo = "openclaw/clawsweeper";
const oldHead = "a".repeat(40);
const newHead = "b".repeat(40);
const firstUpdatedAt = "2026-08-12T01:00:00Z";
const nextUpdatedAt = "2026-08-12T03:00:00Z";

function commit(sha: string, message: string) {
  return {
    sha,
    node_id: `commit-${sha}`,
    author: { login: "contributor", avatar_url: "https://avatars.example/contributor" },
    commit: { message, author: { name: "Contributor", email: "public@example.com" } },
    files_url: "https://api.github.com/unneeded",
  };
}

function comment(id: number, updatedAt: string, body: string) {
  return {
    id,
    user: { login: "reviewer" },
    author_association: "CONTRIBUTOR",
    html_url: `https://github.com/${repo}/pull/42#discussion_r${id}`,
    created_at: "2026-08-12T00:00:00Z",
    updated_at: updatedAt,
    body,
    pull_request_review_id: 900 + id,
    path: "src/example.ts",
    line: id,
    side: "RIGHT",
    commit_id: oldHead,
    node_id: `comment-${id}`,
    diff_hunk: "@@ unneeded API metadata @@",
    reactions: { total_count: 1 },
  };
}

function hydration(items: unknown[]) {
  return { items, total: items.length, hydrated: items.length, truncated: false };
}

function reviewInputBytes(result: {
  commits: { items: unknown[] };
  reviewComments: { items: unknown[] };
  completeReviewComments: unknown[];
}): string {
  const record = (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const normalizedComment = (value: unknown) => {
    const source = record(value);
    return {
      id: source.id ?? null,
      user: record(source.user).login ?? null,
      author_association: source.author_association ?? null,
      html_url: source.html_url ?? null,
      created_at: source.created_at ?? null,
      updated_at: source.updated_at ?? null,
      body: source.body ?? null,
      pull_request_review_id: source.pull_request_review_id ?? null,
      in_reply_to_id: source.in_reply_to_id ?? null,
      path: source.path ?? null,
      line: source.line ?? null,
      side: source.side ?? null,
      start_line: source.start_line ?? null,
      start_side: source.start_side ?? null,
      original_line: source.original_line ?? null,
      original_commit_id: source.original_commit_id ?? null,
      commit_id: source.commit_id ?? null,
    };
  };
  return JSON.stringify({
    commits: result.commits.items.map((value) => {
      const source = record(value);
      const commit = record(source.commit);
      return {
        sha: source.sha ?? null,
        author: record(source.author).login ?? null,
        message: commit.message ?? null,
        commitAuthor: record(commit.author).name ?? null,
      };
    }),
    reviewComments: result.reviewComments.items.map(normalizedComment),
    completeReviewComments: result.completeReviewComments.map(normalizedComment),
  });
}

function initialSnapshot(options: {
  number: number;
  commits: unknown[];
  comments: unknown[];
  headSha?: string;
}): PrHydrationSnapshot {
  const result = hydratePrLists({
    repo,
    number: options.number,
    pullUpdatedAt: firstUpdatedAt,
    headSha: options.headSha ?? oldHead,
    commitCount: options.commits.length,
    reviewCommentCount: options.comments.length,
    prior: null,
    fetchCommits: () => hydration(options.commits),
    fetchReviewComments: () => hydration(options.comments),
    fetchCompleteReviewComments: () => options.comments,
    fetchReviewCommentsSince: () => {
      throw new Error("cold hydration must not use since");
    },
    now: () => "2026-08-12T02:00:00Z",
  });
  assert.ok(result.snapshot);
  return result.snapshot;
}

test("unchanged PR hydration snapshots reuse both lists with zero reads", () => {
  let listCalls = 0;
  const snapshots = [1, 2, 3].map((number) =>
    initialSnapshot({
      number,
      commits: [commit(String(number).repeat(40), `commit ${number}`)],
      comments: [comment(number, firstUpdatedAt, `comment ${number}`)],
    }),
  );

  for (const [index, prior] of snapshots.entries()) {
    const result = hydratePrLists({
      repo,
      number: index + 1,
      pullUpdatedAt: firstUpdatedAt,
      headSha: oldHead,
      commitCount: 1,
      reviewCommentCount: 1,
      prior,
      fetchCommits: () => {
        listCalls += 1;
        throw new Error("unchanged commits must be reused");
      },
      fetchReviewComments: () => {
        listCalls += 1;
        throw new Error("unchanged review comments must be reused");
      },
      fetchCompleteReviewComments: () => {
        throw new Error("unchanged review comments must stay complete");
      },
      fetchReviewCommentsSince: () => {
        listCalls += 1;
        throw new Error("unchanged review comments must not use since");
      },
    });
    assert.equal(result.commitsReused, true);
    assert.equal(result.reviewCommentsReused, true);
  }
  assert.equal(listCalls, 0);
});

test("changed PRs preserve full hydration bytes with partial or full reads", () => {
  const oldCommits = [commit("1".repeat(40), "first")];
  const oldComments = [comment(1, firstUpdatedAt, "before")];
  const editPrior = initialSnapshot({ number: 41, commits: oldCommits, comments: oldComments });
  const editedComments = [comment(1, nextUpdatedAt, "after")];
  let changedListCalls = 0;
  const edited = hydratePrLists({
    repo,
    number: 41,
    pullUpdatedAt: nextUpdatedAt,
    headSha: oldHead,
    commitCount: 1,
    reviewCommentCount: 1,
    prior: editPrior,
    fetchCommits: () => {
      changedListCalls += 1;
      throw new Error("unchanged commit identity must reuse the snapshot");
    },
    fetchReviewComments: () => {
      changedListCalls += 1;
      throw new Error("visible edit should merge from since");
    },
    fetchCompleteReviewComments: () => editedComments,
    fetchReviewCommentsSince: (since) => {
      changedListCalls += 1;
      assert.equal(since, "2026-08-12T01:59:59.000Z");
      return editedComments;
    },
  });
  const editedFresh = hydratePrLists({
    repo,
    number: 41,
    pullUpdatedAt: nextUpdatedAt,
    headSha: oldHead,
    commitCount: 1,
    reviewCommentCount: 1,
    prior: null,
    fetchCommits: () => hydration(oldCommits),
    fetchReviewComments: () => hydration(editedComments),
    fetchCompleteReviewComments: () => editedComments,
    fetchReviewCommentsSince: () => [],
  });
  assert.equal(edited.reviewCommentsIncremental, true);
  assert.equal(reviewInputBytes(edited), reviewInputBytes(editedFresh));

  const forcedCommits = [commit("2".repeat(40), "replacement")];
  const forcedComments = [comment(2, nextUpdatedAt, "new head")];
  const forcePrior = initialSnapshot({ number: 42, commits: oldCommits, comments: oldComments });
  const forced = hydratePrLists({
    repo,
    number: 42,
    pullUpdatedAt: nextUpdatedAt,
    headSha: newHead,
    commitCount: 1,
    reviewCommentCount: 1,
    prior: forcePrior,
    fetchCommits: () => {
      changedListCalls += 1;
      return hydration(forcedCommits);
    },
    fetchReviewComments: () => {
      changedListCalls += 1;
      return hydration(forcedComments);
    },
    fetchCompleteReviewComments: () => forcedComments,
    fetchReviewCommentsSince: () => {
      throw new Error("force-push must fully rehydrate");
    },
  });
  const forcedFresh = hydratePrLists({
    repo,
    number: 42,
    pullUpdatedAt: nextUpdatedAt,
    headSha: newHead,
    commitCount: 1,
    reviewCommentCount: 1,
    prior: null,
    fetchCommits: () => hydration(forcedCommits),
    fetchReviewComments: () => hydration(forcedComments),
    fetchCompleteReviewComments: () => forcedComments,
    fetchReviewCommentsSince: () => [],
  });
  assert.equal(reviewInputBytes(forced), reviewInputBytes(forcedFresh));
  assert.equal(changedListCalls, 3, "one partial edit read plus two force-push full reads");
  assert.deepEqual({ before: 2 * (3 + 2), after: changedListCalls }, { before: 10, after: 3 });
});

test("invisible review-comment deletion falls back to a full read", () => {
  const priorComments = [comment(1, firstUpdatedAt, "deleted"), comment(2, firstUpdatedAt, "kept")];
  const currentComments = [comment(2, firstUpdatedAt, "kept"), comment(3, nextUpdatedAt, "new")];
  const prior = initialSnapshot({
    number: 43,
    commits: [commit("3".repeat(40), "same")],
    comments: priorComments,
  });
  let fullReads = 0;
  const result = hydratePrLists({
    repo,
    number: 43,
    pullUpdatedAt: nextUpdatedAt,
    headSha: oldHead,
    commitCount: 1,
    reviewCommentCount: 2,
    prior,
    fetchCommits: () => {
      throw new Error("commit snapshot should be reused");
    },
    fetchReviewComments: () => {
      fullReads += 1;
      return hydration(currentComments);
    },
    fetchCompleteReviewComments: () => currentComments,
    fetchReviewCommentsSince: () => [currentComments[1]],
  });

  assert.equal(result.reviewCommentsFullFallback, true);
  assert.equal(fullReads, 1);
  assert.equal(JSON.stringify(result.completeReviewComments), JSON.stringify(currentComments));
});

test("hydration snapshot front matter round-trips", () => {
  const snapshot = initialSnapshot({
    number: 44,
    commits: [commit("4".repeat(40), "round trip")],
    comments: [comment(4, firstUpdatedAt, "round trip")],
  });
  const serialized = serializePrHydrationSnapshot(snapshot);
  assert.deepEqual(parsePrHydrationSnapshot(serialized), snapshot);
  for (const omittedField of [
    "avatar_url",
    "diff_hunk",
    "email",
    "files_url",
    "node_id",
    "reactions",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(omittedField));
  }
  assert.equal(parsePrHydrationSnapshot("unknown"), null);
  assert.equal(parsePrHydrationSnapshot('{"version":999}'), null);
});
