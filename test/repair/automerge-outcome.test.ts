import assert from "node:assert/strict";
import test from "node:test";

import {
  automergeOutcomeReviewedShaFromResult,
  automergePlanningHeadBlock,
} from "../../dist/repair/automerge-outcome.js";

test("automerge no-op continuation derives target head from matching canonical PR", () => {
  const headSha = "92dca8fde03aee8da56a84a011fa387b9c1640fe";
  const reviewedSha = automergeOutcomeReviewedShaFromResult({
    repo: "openclaw/openclaw",
    target: 83707,
    result: {
      repo: "openclaw/openclaw",
      canonical_pr: "https://github.com/openclaw/openclaw/pull/83707",
      fix_artifact: null,
    },
    targetView: {
      headRefOid: headSha,
    },
  });

  assert.equal(reviewedSha, headSha);
});

test("automerge no-op continuation does not borrow head from a different canonical PR", () => {
  const reviewedSha = automergeOutcomeReviewedShaFromResult({
    repo: "openclaw/openclaw",
    target: 83707,
    result: {
      repo: "openclaw/openclaw",
      canonical_pr: "https://github.com/openclaw/openclaw/pull/82166",
      fix_artifact: null,
    },
    targetView: {
      headRefOid: "92dca8fde03aee8da56a84a011fa387b9c1640fe",
    },
  });

  assert.equal(reviewedSha, null);
});

test("automerge planning head binding accepts only the exact reviewed revision", () => {
  const reviewed = "a".repeat(40);
  const drifted = "b".repeat(40);
  assert.equal(
    automergePlanningHeadBlock({ expectedHeadSha: reviewed, currentHeadSha: reviewed }),
    null,
  );
  assert.deepEqual(
    automergePlanningHeadBlock({ expectedHeadSha: reviewed, currentHeadSha: drifted }),
    {
      reason: `source PR head changed after automerge planning: expected ${reviewed}, current ${drifted}`,
      expectedHeadSha: reviewed,
      currentHeadSha: drifted,
    },
  );
  assert.match(
    automergePlanningHeadBlock({ expectedHeadSha: null, currentHeadSha: reviewed })?.reason ?? "",
    /missing a valid reviewed head SHA/,
  );
});

test("automerge continuation matches a canonical PR whose slug differs only by case", () => {
  // GitHub repository slugs are case-insensitive and github.com serves this URL.
  // canonical_pr is model-authored and unconstrained by the result schema, so a
  // model that echoes the repository's display casing must still resolve.
  const headSha = "92dca8fde03aee8da56a84a011fa387b9c1640fe";
  for (const canonicalPr of [
    "https://github.com/OpenClaw/OpenClaw/pull/83707",
    "https://github.com/openclaw/OPENCLAW/pull/83707",
    "https://GitHub.com/OpenClaw/openclaw/pull/83707",
  ]) {
    assert.equal(
      automergeOutcomeReviewedShaFromResult({
        repo: "openclaw/openclaw",
        target: 83707,
        result: { repo: "openclaw/openclaw", canonical_pr: canonicalPr, fix_artifact: null },
        targetView: { headRefOid: headSha },
      }),
      headSha,
      `${canonicalPr} should resolve against openclaw/openclaw`,
    );
  }
});

test("automerge continuation still rejects a genuinely different repository", () => {
  // Case-insensitive matching must not widen into cross-repository borrowing.
  for (const canonicalPr of [
    "https://github.com/openclaw/other-repo/pull/83707",
    "https://github.com/OtherOwner/OpenClaw/pull/83707",
  ]) {
    assert.equal(
      automergeOutcomeReviewedShaFromResult({
        repo: "openclaw/openclaw",
        target: 83707,
        result: { repo: "openclaw/openclaw", canonical_pr: canonicalPr, fix_artifact: null },
        targetView: { headRefOid: "92dca8fde03aee8da56a84a011fa387b9c1640fe" },
      }),
      null,
      `${canonicalPr} must not borrow a head`,
    );
  }
});

test("sameRepoSlug compares case-insensitively without matching empty slugs", async () => {
  const { sameRepoSlug } = await import("../../dist/repair/github-ref.js");
  assert.equal(sameRepoSlug("OpenClaw/OpenClaw", "openclaw/openclaw"), true);
  assert.equal(sameRepoSlug("  openclaw/openclaw  ", "openclaw/openclaw"), true);
  assert.equal(sameRepoSlug("openclaw/openclaw", "openclaw/other"), false);
  // An absent slug must never satisfy a repository guard.
  assert.equal(sameRepoSlug(undefined, undefined), false);
  assert.equal(sameRepoSlug("", ""), false);
  assert.equal(sameRepoSlug(null, "openclaw/openclaw"), false);
  assert.equal(sameRepoSlug("openclaw/openclaw", undefined), false);
});
