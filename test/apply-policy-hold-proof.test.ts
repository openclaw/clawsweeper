import assert from "node:assert/strict";
import test from "node:test";
import {
  createApplyGuardActivity,
  issueRecentHumanCommentBlockFromComments,
} from "../dist/clawsweeper-apply-guard-activity.js";
import { createApplyGuardCapacity } from "../dist/clawsweeper-apply-guard-capacity.js";

import { unconfirmedProductDirectionAgeBlock } from "../dist/clawsweeper-item-policy.js";
import { createApplyGuardPolicy } from "../dist/clawsweeper-apply-guard-policy.js";

const now = Date.parse("2026-10-16T12:00:00Z");
test("only a dated recent non-bot comment proves a policy hold", () => {
  for (const [date, bot, expected] of [
    ["2026-10-01T00:00:00Z", false, true],
    ["invalid", false, undefined],
    ["", false, undefined],
    ["2020-01-01T00:00:00Z", false, undefined],
    ["2026-10-01T00:00:00Z", true, undefined],
  ] as const) {
    const result = issueRecentHumanCommentBlockFromComments(
      [{ created_at: date, user: { type: bot ? "Bot" : "User" } }],
      60,
      now,
    );
    assert.equal(result?.closePolicyHoldVerified, expected);
  }
});

test("missing actor metadata does not prove a human-activity hold", () => {
  const result = issueRecentHumanCommentBlockFromComments(
    [{ created_at: "2026-10-01T00:00:00Z" }],
    60,
    now,
  );
  assert.ok(result);
  assert.equal(result.closePolicyHoldVerified, undefined);
});

test("failed comment reads remain unverified policy blocks", () => {
  const guards = createApplyGuardActivity({
    targetRepo: () => "example/repo",
    ghJson: () => {
      throw new Error("unexpected read");
    },
    ghPaged: () => {
      throw new Error("unavailable");
    },
  });
  assert.deepEqual(guards.issueRecentHumanCommentBlockSafe(42, 60), {
    reason: "issue comment activity check failed: unavailable",
  });
});

test("obsolete-fix activity proves a hold only after a successful dated current-head read", () => {
  const previous = process.env.CLAWSWEEPER_OBSOLETE_FIX_PR_CLOSE_ENABLED;
  process.env.CLAWSWEEPER_OBSOLETE_FIX_PR_CLOSE_ENABLED = "true";
  try {
    for (const scenario of ["recent", "missing-head", "missing-date", "read-failure"] as const) {
      const guards = createApplyGuardCapacity(
        {
          targetRepo: () => "example/repo",
          ghJson: (() => {
            if (scenario === "read-failure") throw new Error("unavailable");
            return {
              commit: {
                committer: { date: scenario === "missing-date" ? "" : new Date().toISOString() },
              },
            };
          }) as never,
        },
        {
          pullRequestLiveActivity: () => ({
            state: "open",
            createdAt: "2020-01-01T00:00:00Z",
            headSha: scenario === "missing-head" ? "" : "a".repeat(40),
            changedFiles: 1,
          }),
        } as never,
      );
      const result = guards.obsoleteFixPrApplyBlockSafe(42, { createdAt: "2020-01-01T00:00:00Z" });
      assert.equal(result?.closePolicyHoldVerified, scenario === "recent" ? true : undefined);
      assert.ok(result?.reason);
    }
  } finally {
    if (previous === undefined) delete process.env.CLAWSWEEPER_OBSOLETE_FIX_PR_CLOSE_ENABLED;
    else process.env.CLAWSWEEPER_OBSOLETE_FIX_PR_CLOSE_ENABLED = previous;
  }
});

test("product-direction age holds need valid ordered timestamps", () => {
  const old = "2026-09-01T00:00:00Z";
  const recent = "2026-10-15T00:00:00Z";
  for (const [createdAt, sourceAt, reviewedAt, expected] of [
    [old, recent, recent, true],
    [old, "2026-10-09T12:00:00Z", "2026-10-16T12:00:00Z", true],
    [recent, old, recent, true],
    ["invalid", recent, recent, undefined],
    ["2026-10-20T00:00:00Z", recent, recent, undefined],
    [old, undefined, recent, undefined],
    [old, "invalid", recent, undefined],
    [old, recent, undefined, undefined],
    [old, recent, "invalid", undefined],
    [old, recent, old, undefined],
    [old, recent, "2026-10-20T00:00:00Z", undefined],
  ] as const) {
    const block = unconfirmedProductDirectionAgeBlock({ createdAt }, sourceAt, reviewedAt, now);
    assert.ok(block);
    assert.equal(block.closePolicyHoldVerified, expected);
  }
  assert.equal(
    unconfirmedProductDirectionAgeBlock(
      { createdAt: old },
      "2026-10-09T11:59:59.999Z",
      "2026-10-16T12:00:00Z",
      now,
    ),
    null,
  );
});

test("product-direction failed reads never prove a policy hold", () => {
  const previous = process.env.CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED;
  process.env.CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED = "true";
  try {
    const guards = createApplyGuardPolicy(
      {
        targetRepo: () => "example/repo",
        ghJson: () => {
          throw new Error("unavailable");
        },
        ghPaged: () => {
          throw new Error("unexpected read");
        },
      },
      {} as never,
    );
    const block = guards.unconfirmedProductDirectionApplyBlockSafe(
      42,
      { createdAt: "2020-01-01T00:00:00Z", labels: [] },
      "2020-01-01T00:00:00Z",
      "2020-02-01T00:00:00Z",
    );
    assert.equal(block?.reason, "product-direction calibration check failed: unavailable");
    assert.equal(block?.closePolicyHoldVerified, undefined);
  } finally {
    if (previous === undefined)
      delete process.env.CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED;
    else process.env.CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED = previous;
  }
});
