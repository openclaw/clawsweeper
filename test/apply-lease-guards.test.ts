import assert from "node:assert/strict";
import test from "node:test";

import { executeApplyClose } from "../dist/clawsweeper-apply-close-execution.js";
import { createApplyLeaseGuards } from "../dist/clawsweeper-apply-lease-guards.js";
import { renderReviewStartStatusComment } from "../dist/clawsweeper.js";

const headSha = "a".repeat(40);
const leaseOwner = "exact-pr-42";
const lease = { owner: leaseOwner, commentId: 700042, headSha };
const startedAt = new Date().toISOString();
const leaseComment = {
  id: lease.commentId,
  user: { login: "clawsweeper[bot]" },
  created_at: startedAt,
  updated_at: startedAt,
  body: renderReviewStartStatusComment({
    number: 42,
    kind: "pull_request",
    title: "Lease guard proof",
    headSha,
    startedAt,
    leaseExpiresAt: new Date(Date.parse(startedAt) + 10 * 60_000).toISOString(),
    leaseOwner,
    purpose: "apply",
  }),
};

function leaseGuards(calls: string[], activityBlock: string | null = null) {
  return createApplyLeaseGuards({
    canonicalBoundStaleReviewReason: () => {
      calls.push("canonical");
      return null;
    },
    closeDelayMs: 0,
    currentReviewActivityBlock: () => {
      calls.push("activity");
      return activityBlock;
    },
    dryRun: false,
    getActiveApplyMutationLease: () => ({ itemNumber: 42, lease }),
    ghJson: () => {
      calls.push("pull");
      return { head: { sha: headSha } };
    },
    GitHubRuntimeBudgetError: class extends Error {},
    initialReviewHeadSha: headSha,
    issueReviewCommentState: () => {
      calls.push("comments");
      return { comments: [leaseComment], leaseComments: [leaseComment] };
    },
    item: { kind: "pull_request" },
    liveIssueSourceRevision: () => headSha,
    markdownBeforeApplyDecisionMutations: "",
    number: 42,
    PATCHABLE_REVIEW_COMMENT_AUTHORS: new Set(["clawsweeper[bot]"]),
    postReviewStartStatusComment: () => ({ status: "posted", lease }),
    reportReviewRevision: headSha,
    requiresApplyMutationLease: true,
    setActiveApplyMutationLease: () => undefined,
    shouldPreserveReviewStartLease: () => false,
    targetRepo: () => "openclaw/openclaw",
  } as unknown as Parameters<typeof createApplyLeaseGuards>[0]);
}

test("held-lease mutation boundaries run the review-activity barrier once", () => {
  const calls: string[] = [];
  assert.equal(leaseGuards(calls).currentApplyMutationLeaseBlockReason(), null);
  // One two-read activity barrier, then the head/comment/head lease sandwich and
  // the canonical freshness check. The barrier used to run twice back to back.
  assert.deepEqual(calls, ["activity", "pull", "comments", "pull", "canonical"]);
});

test("review-activity drift still blocks before any lease read", () => {
  const calls: string[] = [];
  assert.equal(
    leaseGuards(
      calls,
      "pull request review activity changed since review",
    ).currentApplyMutationLeaseBlockReason(),
    "pull request review activity changed since review",
  );
  assert.deepEqual(calls, ["activity"]);
});

test("lease acquisition keeps its own review-activity barrier", () => {
  const calls: string[] = [];
  const guards = leaseGuards(calls);
  assert.equal(
    guards.acquireApplyMutationLease({
      comment: undefined,
      comments: [leaseComment],
      leaseComments: [leaseComment],
      headSha,
      lease: { ...lease, startedAt, expiresAt: startedAt },
      preserve: false,
      blockReason: null,
    }),
    null,
  );
  assert.deepEqual(calls, ["activity", "pull", "comments", "pull", "canonical"]);
});

// Unknown dependencies fail the test, so the close path uses only the listed fakes.
function strict<T extends object>(label: string, values: T): T {
  return new Proxy(values, {
    get(target, key) {
      if (key in target) return Reflect.get(target, key);
      return () => {
        throw new Error(`unexpected ${label}: ${String(key)}`);
      };
    },
  });
}

test("apply does not close an item after it loses its mutation lease during close execution", () => {
  for (const [name, lostAfterChecks, expectedClosed] of [
    ["lease held", Infinity, [42]],
    ["lease lost after the first check", 1, []],
  ] as const) {
    const closed: number[] = [];
    const leaseSkips: string[] = [];
    let leaseChecks = 0;
    let markdown = "---\nitem_updated_at: 2026-05-01T00:00:00Z\n---\n";
    executeApplyClose(
      strict("dependency", {
        closeReasonEnabled: () => true,
        implementedOnMainPullRequestProvenanceApplyBlock: () => null,
        validateCloseDecision: () => ({ ok: true }),
        reportDecision: () => ({}),
        closeReasonApplyAgeSkipReason: () => null,
        normalizeLabelName: (label: string) => label,
        resetGuardReadCache: () => undefined,
        withGuardReadOptions: (_options: unknown, run: () => unknown) => run(),
        closeItem: ({ number }: { number: number }) => closed.push(number),
        ensureRuntimeDelayFits: () => undefined,
        sleepMs: () => undefined,
      }) as never,
      strict("option", {
        applyCloseReasons: null,
        applyKind: "all",
        closeReason: "not_actionable_in_repo",
        closeLimitReached: false,
        requiredMaintainerDecision: null,
        item: {
          kind: "issue",
          number: 42,
          labels: [],
          repo: "openclaw/openclaw",
          authorAssociation: "NONE",
        },
        number: 42,
        repo: "openclaw/openclaw",
        dryRun: false,
        isRetryableSkippedClose: false,
        getMarkdown: () => markdown,
        setMarkdown: (value: string) => (markdown = value),
        itemsDir: "items",
        closedDir: "closed",
        minAgeMs: 0,
        minAgeDescription: "0 minutes",
        staleMinAgeDays: 60,
        closeDelayMs: 0,
        reviewComment: "Closing.",
        emitEventApplyProof: false,
        postProofCoveringPrFreshnessBlock: () => null,
        postProofFreshnessBlock: () => null,
        currentSameAuthorPairBlockReason: () => null,
        currentObsoleteFixPrBlockReason: () => null,
        currentStaleVersionBugBlockReason: () => null,
        currentAuthorPrBudgetApplyGate: () => ({ block: null }),
        setCloseMutationPolicyGuard: () => undefined,
        currentApplyMutationLeaseBlockReason: () =>
          ++leaseChecks > lostAfterChecks ? "apply mutation lease is not held" : null,
        recordReviewLeaseSkip: (reason: string) => (leaseSkips.push(reason), false),
        archiveClosed: () => undefined,
        onClosed: () => false,
        logProgress: () => undefined,
      }) as never,
    );
    assert.deepEqual(closed, expectedClosed, name);
    assert.deepEqual(
      leaseSkips,
      expectedClosed.length ? [] : ["apply mutation lease is not held"],
      name,
    );
  }
});
