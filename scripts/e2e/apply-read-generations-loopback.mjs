import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";

import { createApplyLeaseGuards } from "../../dist/clawsweeper-apply-lease-guards.js";
import { renderReviewStartStatusComment } from "../../dist/clawsweeper.js";
import { LiveReadGeneration } from "../../dist/live-read-generation.js";
import { hydratePrLists } from "../../dist/pr-hydration-snapshot.js";

const reviewedHead = "a".repeat(40);
const changedHead = "c".repeat(40);
const activityRevision = `sha256:${"1".repeat(64)}`;
const leaseOwner = "apply-read-generation-proof";
const leaseStartedAt = new Date().toISOString();
const leaseExpiresAt = new Date(Date.parse(leaseStartedAt) + 10 * 60 * 1000).toISOString();
const leaseComment = {
  id: 700042,
  user: { login: "clawsweeper[bot]" },
  created_at: leaseStartedAt,
  updated_at: leaseStartedAt,
  body: renderReviewStartStatusComment({
    number: 42,
    kind: "pull_request",
    title: "Generation proof",
    headSha: reviewedHead,
    startedAt: leaseStartedAt,
    leaseExpiresAt,
    leaseOwner,
    purpose: "apply",
  }),
};

const server = spawn(
  process.execPath,
  [new URL("./apply-read-generations-loopback-server.mjs", import.meta.url).pathname],
  { stdio: ["ignore", "pipe", "inherit"] },
);
const chunks = [];
let port;
server.stdout.setEncoding("utf8");
server.stdout.on("data", (chunk) => {
  chunks.push(chunk);
  const line = chunks.join("").split("\n", 1)[0];
  if (/^\d+$/.test(line)) port = Number(line);
});
while (!port) await once(server.stdout, "data");
const base = `http://127.0.0.1:${port}`;

function request(path, options = {}) {
  const args = ["--fail", "--silent", "--show-error"];
  if (options.body !== undefined) {
    args.push(
      "--request",
      "POST",
      "--header",
      "content-type: application/json",
      "--data-binary",
      JSON.stringify(options.body),
    );
  }
  args.push(`${base}${path}`);
  return JSON.parse(execFileSync("curl", args, { encoding: "utf8" }));
}

const reset = () => request("/reset", { body: {} });
const counts = () => request("/counts");
const get = (path) => request(path);
const hydration = (items) => ({
  items,
  total: items.length,
  hydrated: items.length,
  truncated: false,
});

function issueReviewCommentState(generation, bypassGenerationCache) {
  const comments = generation.read("paged:comments", () => get("/comments"), {
    bypassGenerationCache,
  });
  return {
    comments,
    reviewComment: comments.find((comment) => comment.id === 800042),
    leaseComment,
    leaseComments: [leaseComment],
    dedicatedLeaseComment: leaseComment,
    dedicatedLeaseComments: [leaseComment],
  };
}

function leaseGuards(generation) {
  const active = {
    itemNumber: 42,
    lease: { owner: leaseOwner, commentId: 700042, headSha: reviewedHead },
  };
  return createApplyLeaseGuards({
    asRecord: (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {}),
    canonicalBoundStaleReviewReason: (_markdown, comment) =>
      comment?.id === 800042 ? "new durable comment arrived between generations" : null,
    closeDelayMs: 0,
    currentReviewActivityBlock: () => null,
    dryRun: false,
    frontMatterValue: (_markdown, key) => {
      if (key === "review_lease_owner") return leaseOwner;
      if (key === "review_lease_comment_id") return "700042";
      return undefined;
    },
    getActiveApplyMutationLease: () => active,
    ghJson: () => get("/pull"),
    GitHubRuntimeBudgetError: class extends Error {},
    initialReviewHeadSha: reviewedHead,
    issueReviewCommentState: (_number, _fallback, options) =>
      issueReviewCommentState(generation, options?.bypassGenerationCache === true),
    item: {
      repo: "openclaw/clawsweeper",
      number: 42,
      kind: "pull_request",
      title: "Generation proof",
      url: "https://github.com/openclaw/clawsweeper/pull/42",
      createdAt: "2026-08-13T00:00:00Z",
      updatedAt: "2026-08-13T00:00:00Z",
      author: "contributor",
      authorAssociation: "CONTRIBUTOR",
      labels: [],
    },
    liveIssueSourceRevision: () => "",
    liveReadGeneration: generation,
    markdownBeforeApplyDecisionMutations: "proof",
    number: 42,
    PATCHABLE_REVIEW_COMMENT_AUTHORS: new Set(["clawsweeper[bot]"]),
    postReviewStartStatusComment: () => ({ status: "held" }),
    reportReviewRevision: reviewedHead,
    requiresApplyMutationLease: true,
    reviewLeaseRevisionFromReport: () => reviewedHead,
    setActiveApplyMutationLease: () => {},
    shouldPreserveReviewStartLease: () => false,
    targetRepo: () => "openclaw/clawsweeper",
  });
}

try {
  reset();
  const generation = new LiveReadGeneration();
  generation.read("json:pull", () => get("/pull"));
  generation.read("paged:comments", () => get("/comments"));
  const guards = leaseGuards(generation);

  const beforeBarrier = counts();
  assert.deepEqual(beforeBarrier, { "/pull": 1, "/comments": 1 });
  assert.equal(guards.currentApplyMutationLeaseBlockReason(), null);
  const afterCommentBarrier = counts();
  assert.equal(afterCommentBarrier["/pull"] - beforeBarrier["/pull"], 2);
  assert.equal(afterCommentBarrier["/comments"] - beforeBarrier["/comments"], 1);
  assert.equal(guards.currentApplyMutationLeaseBlockReason(), null);
  const afterCloseBarrier = counts();
  assert.equal(afterCloseBarrier["/pull"] - afterCommentBarrier["/pull"], 2);
  assert.equal(afterCloseBarrier["/comments"] - afterCommentBarrier["/comments"], 1);

  request("/mutate", { body: { head: changedHead } });
  generation.invalidate();
  assert.match(
    guards.refreshReviewStartLeaseState().blockReason ?? "",
    /PR head changed since context capture/,
  );

  reset();
  const commentGeneration = new LiveReadGeneration();
  const commentGuards = leaseGuards(commentGeneration);
  commentGeneration.read("json:pull", () => get("/pull"));
  commentGeneration.read("paged:comments", () => get("/comments"));
  request("/mutate", {
    body: {
      comments: [
        {
          id: 800042,
          user: { login: "maintainer" },
          body: "new comment",
          created_at: "2026-08-13T00:01:00Z",
          updated_at: "2026-08-13T00:01:00Z",
        },
      ],
    },
  });
  commentGeneration.invalidate();
  assert.equal(
    commentGuards.currentApplyMutationLeaseBlockReason(),
    "new durable comment arrived between generations",
  );

  reset();
  const cold = hydratePrLists({
    repo: "openclaw/clawsweeper",
    number: 42,
    pullUpdatedAt: "2026-08-13T00:00:00Z",
    headSha: reviewedHead,
    changedFileCount: 1,
    commitCount: 1,
    reviewCommentCount: 1,
    commentActivityRevision: activityRevision,
    prior: null,
    fetchFiles: () => hydration(get("/files")),
    fetchCommits: () => hydration(get("/commits")),
    fetchReviewComments: () => hydration(get("/inline-comments")),
    fetchCompleteReviewComments: () => get("/inline-comments"),
    fetchReviewCommentsSince: () => get("/inline-comments"),
    revalidateCommentActivityRevision: () => null,
  });
  assert.ok(cold.snapshot);
  reset();
  const reused = hydratePrLists({
    repo: "openclaw/clawsweeper",
    number: 42,
    pullUpdatedAt: "2026-08-13T00:00:00Z",
    headSha: reviewedHead,
    changedFileCount: 1,
    commitCount: 1,
    reviewCommentCount: 1,
    commentActivityRevision: activityRevision,
    prior: cold.snapshot,
    requireFullyValidatedSnapshot: true,
    revalidateCommentActivityRevision: () => get("/activity").revision,
    fetchFiles: () => hydration(get("/files")),
    fetchCommits: () => hydration(get("/commits")),
    fetchReviewComments: () => hydration(get("/inline-comments")),
    fetchCompleteReviewComments: () => get("/inline-comments"),
    fetchReviewCommentsSince: () => get("/inline-comments"),
  });
  assert.equal(reused.filesReused, true);
  assert.equal(reused.commitsReused, true);
  assert.equal(reused.reviewCommentsReused, true);
  const snapshotCounts = counts();
  assert.equal(snapshotCounts["/activity"], 1);
  assert.equal(snapshotCounts["/files"] ?? 0, 0);
  assert.equal(snapshotCounts["/commits"] ?? 0, 0);
  assert.equal(snapshotCounts["/inline-comments"] ?? 0, 0);

  reset();
  const applyGeneration = new LiveReadGeneration();
  const shared = (key, path) => applyGeneration.read(key, () => get(path));
  shared("issue", "/issue");
  shared("issue", "/issue");
  shared("pull", "/pull");
  shared("pull", "/pull");
  shared("comments", "/comments");
  shared("comments", "/comments");
  shared("timeline", "/timeline");
  shared("timeline", "/timeline");
  shared("reviews", "/reviews");
  shared("inline", "/inline-comments");
  const generationCounts = counts();
  const beforeFormula = 1 + 4 + 6 + 3;
  const afterFormula = Object.values(generationCounts).reduce((sum, value) => sum + value, 0) + 3;
  assert.equal(beforeFormula, 14);
  assert.equal(afterFormula, 9);

  process.stdout.write(
    `${JSON.stringify(
      {
        provider_surface: "loopback-http",
        counted_formula: { before: "F(1)+C(4)+P(6)+L(3)=14", after: "U(6)+L_live(3)=9" },
        barrier_live_reads: { pull_per_barrier: 2, comments_per_barrier: 1 },
        concurrent_head_blocked: true,
        concurrent_comment_blocked: true,
        validated_snapshot_list_reads: { files: 0, commits: 0, inline_comments: 0 },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  server.kill("SIGTERM");
  await once(server, "exit");
}
