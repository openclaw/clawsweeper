import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  issueCloseProofScenarios,
  runIssueCloseProof,
} from "../scripts/e2e/apply-issue-close-freshness.mjs";
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

assert.equal(issueCloseProofScenarios.length, 17);
for (const scenario of issueCloseProofScenarios)
  test(
    `actual apply CLI preserves issue close freshness: ${scenario}`,
    { timeout: 75_000 },
    async (t) => {
      const results = await runIssueCloseProof({ scenario, signal: t.signal });
      assert.equal(results.length, 1);
      assert.equal(results[0].scenario, scenario);
    },
  );

test(
  "cancellation during final boundary cleanup cannot report proof success",
  { timeout: 15_000 },
  async (t) => {
    const controller = new AbortController();
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    t.mock.method(controller.signal, "removeEventListener", (...args) => {
      remove(...args);
      controller.abort(new Error("late cleanup cancellation"));
    });
    await assert.rejects(
      runIssueCloseProof({ scenario: "legacy_missing_source_synced", signal: controller.signal }),
      /late cleanup cancellation/,
    );
  },
);

test("aborted issue proof reaps its CLI tree and boundary", { timeout: 15_000 }, async (t) => {
  const artifactDir = mkdtempSync(join(tmpdir(), "issue-proof-interrupt-"));
  const controller = new AbortController();
  const result = runIssueCloseProof({
    scenario: "no_drift",
    artifactDir,
    signal: AbortSignal.any([controller.signal, t.signal]),
  });
  const rejected = assert.rejects(result, /proof interrupted for cleanup test/);
  let settled = false;
  void result.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    let dir;
    while (!dir || !existsSync(join(dir, "http-trace.jsonl"))) {
      assert.equal(settled, false, "proof must reach its real CLI boundary");
      const generation = readdirSync(artifactDir).find((name) => name.startsWith("run-"));
      if (generation) dir = join(artifactDir, generation, "no_drift");
      await delay(10);
    }
    controller.abort(new Error("proof interrupted for cleanup test"));
    await rejected;
    assert.ok(existsSync(join(dir, "failure.json")));
    // POSIX delivers the boundary handler; Windows terminates it directly.
    // Every platform must reap both owned processes, without skipping a case.
    if (process.platform !== "win32")
      assert.ok(
        existsSync(join(dir, "boundary-state.json")),
        "boundary must finish its shutdown receipt",
      );
    const { boundaryPid, cliPid } = JSON.parse(readFileSync(join(dir, "processes.json"), "utf8"));
    for (const pid of [boundaryPid, cliPid])
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    controller.abort(new Error("proof interrupted for cleanup test"));
    await rejected;
    rmSync(artifactDir, { recursive: true, force: true });
  }
});
