import assert from "node:assert/strict";
import test from "node:test";
import {
  createApplyGuardActivity,
  issueRecentHumanCommentBlockFromComments,
} from "../dist/clawsweeper-apply-guard-activity.js";
import { createApplyGuardCapacity } from "../dist/clawsweeper-apply-guard-capacity.js";

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
