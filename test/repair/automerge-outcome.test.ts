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
