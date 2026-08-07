import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../dist/clawsweeper-args.js";
import {
  isExplicitReviewDispatch,
  isReviewCoordinationEnabled,
} from "../dist/clawsweeper-review-preparation.js";

test("scheduled queue source actions are automatic while exact actions remain explicit", () => {
  for (const sourceAction of ["scheduled_hot_intake", "scheduled_normal_backfill"]) {
    const args = parseArgs(["--review-source-action", sourceAction]);
    assert.equal(isExplicitReviewDispatch(args, true), false, sourceAction);
  }

  for (const sourceAction of ["issues_opened", "exact_review_command", "legacy_dispatch", ""]) {
    const args = sourceAction ? parseArgs(["--review-source-action", sourceAction]) : parseArgs([]);
    assert.equal(isExplicitReviewDispatch(args, true), true, sourceAction || "missing action");
  }
});

test("planned review compatibility and non-exact selection preserve existing behavior", () => {
  assert.equal(isExplicitReviewDispatch(parseArgs(["--planned-automatic-review"]), true), false);
  assert.equal(isExplicitReviewDispatch(parseArgs([]), false), false);
});

test("a reserved review lease keeps coordination enabled under --skip-start-comment", () => {
  const reservedLease = { owner: "github-run-31131564193-1", commentId: 5201730501 };

  // The exact-event lane always pairs the two, so this is the production shape.
  assert.equal(isReviewCoordinationEnabled(true, reservedLease), true);

  // A run that neither creates nor receives a lease stays uncoordinated.
  assert.equal(isReviewCoordinationEnabled(true, null), false);
  assert.equal(isReviewCoordinationEnabled(true, undefined), false);

  // Lanes that create their own start comment were already coordinated.
  assert.equal(isReviewCoordinationEnabled(false, null), true);
  assert.equal(isReviewCoordinationEnabled(false, reservedLease), true);
});
