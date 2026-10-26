import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { createApplyProofFreshnessGuards } from "../dist/clawsweeper-apply-proof-freshness.js";
import { completeActivityContextSymbol } from "../dist/clawsweeper-types.js";
import { stableJson } from "../dist/stable-json.js";

function issueFreshness(overrides: Record<string, unknown> = {}) {
  const context = {
    sourceRevision: "source",
    timelineRevision: "timeline",
    [completeActivityContextSymbol]: { comments: [], timeline: [], pullReviewComments: [] },
  };
  return createApplyProofFreshnessGuards({
    action: undefined,
    automationItemUpdatedAt: undefined,
    collectItemContext: (_item: unknown, options: { bypassGenerationCache?: boolean }) => {
      assert.equal(options.bypassGenerationCache, true);
      return context;
    },
    completeReviewActivityReceiptMatches: () => true,
    contextHasNonAutomationActivityAfter: () => false,
    currentProofState: () => ({
      acceptedUpdatedAt: "reviewed",
      storedUpdatedAt: "reviewed",
      prCloseCoverageProofGateChecked: false,
      prCloseCoverageProofStartedAtMs: null,
    }),
    fetchItem: (_number: number, options: { bypassGenerationCache?: boolean }) => {
      assert.equal(options.bypassGenerationCache, true);
      return { state: "open", item: { kind: "issue", updatedAt: "written", locked: false } };
    },
    itemKind: "issue",
    itemSnapshotHash: () => "snapshot",
    number: 321,
    reviewHasCompleteActivityIdentity: true,
    reviewMarkdown: "review",
    retryCloseCoverageCommandStatusOnlyUpdate: () => false,
    selfMutationItemReceipts: [
      {
        updatedAt: "written",
        sourceRevision: "source",
        activityReceipt: stableJson(context[completeActivityContextSymbol]),
        prHeadMatches: true,
        prHeadSha: null,
        reviewActivityCursor: null,
      },
    ],
    ...overrides,
  } as never);
}

test("forced issue close freshness preserves only structurally bound owned writes", () => {
  assert.equal(issueFreshness().postProofFreshnessBlock({ force: true }), null);
  for (const overrides of [
    { selfMutationItemReceipts: [] },
    { reviewHasCompleteActivityIdentity: false },
    { completeReviewActivityReceiptMatches: () => false },
    { collectItemContext: () => ({ sourceRevision: "changed" }) },
  ])
    assert.ok(issueFreshness(overrides).postProofFreshnessBlock({ force: true }));
});

test("forced issue close freshness requires reviewed identity even without a write", () => {
  const guards = issueFreshness({
    reviewHasCompleteActivityIdentity: false,
    selfMutationItemReceipts: [],
    fetchItem: () => ({
      state: "open",
      item: { kind: "issue", updatedAt: "reviewed", locked: false },
    }),
  });
  assert.match(
    guards.postProofFreshnessBlock({ force: true })?.reason ?? "",
    /source identity is missing/,
  );
});

test("forced issue close freshness blocks a lock or closed state even at reviewed timestamp", () => {
  for (const [state, locked, reason] of [
    ["open", true, "conversation is locked"],
    ["closed", false, "state changed to closed"],
  ] as const) {
    const guard = issueFreshness({
      fetchItem: () => ({ state, item: { updatedAt: "reviewed", locked } }),
    });
    assert.equal(guard.postProofFreshnessBlock({ force: true })?.reason, reason);
  }
});

test(
  "actual apply CLI preserves late issue locks, state and human activity",
  { timeout: 180_000 },
  () => {
    const results = JSON.parse(
      execFileSync(process.execPath, ["scripts/e2e/apply-issue-close-freshness.mjs"], {
        encoding: "utf8",
        timeout: 175_000,
      }),
    );
    assert.equal(results.length, 17);
  },
);
