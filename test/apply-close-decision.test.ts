import assert from "node:assert/strict";
import test from "node:test";

import { validateCloseDecision } from "../dist/clawsweeper.js";
import { validateReportClose } from "../dist/clawsweeper-apply-close-decision.js";
import { replaceFrontMatterValue, reportWithoutReviewRecord } from "../dist/report-front-matter.js";
import type { Decision } from "../src/clawsweeper-types.ts";
import { implementedCloseReport, withReviewRecord } from "./helpers.ts";

const issue = { repo: "openclaw/clawsweeper", kind: "issue" as const, labels: [] };

function validate(markdown: string) {
  const validated: Decision[] = [];
  const result = validateReportClose(
    {
      validateCloseDecision: (item, decision, options) => {
        validated.push(decision);
        return validateCloseDecision(item, decision, options);
      },
    },
    issue,
    markdown,
    "implemented_on_main",
    { requireCloseComment: true },
  );
  return { result, decision: validated[0] };
}

test("the apply validates the close from the review record", () => {
  const report = withReviewRecord(implementedCloseReport(), {
    summary: "The record summary.",
    closeComment: "",
  });
  const { result, decision } = validate(report);
  assert.deepEqual(result, { ok: true });
  assert.equal(decision?.summary, "The record summary.");
  assert.deepEqual(
    decision?.evidence.map((entry) => entry.label),
    ["implementation", "git history provenance", "release provenance"],
  );
  assert.equal(
    decision?.closeComment,
    "Closing this because the requested behavior is already on main.",
  );
});

test("the record decides the close when the report text disagrees", () => {
  const report = withReviewRecord(implementedCloseReport(), { fixedSha: null });
  const { result } = validate(report);
  assert.deepEqual(result, {
    ok: false,
    actionTaken: "skipped_invalid_decision",
    reason: "implemented_on_main requires fixedSha",
  });
});

test("a report without a review record blocks the close and asks for a fresh review", () => {
  const { result, decision } = validate(reportWithoutReviewRecord(implementedCloseReport()));
  assert.deepEqual(result, {
    ok: false,
    actionTaken: "skipped_changed_since_review",
    reason: "review_record: missing record; fresh review required",
  });
  assert.equal(decision, undefined);
});

test("a review record that does not read blocks the close and asks for a fresh review", () => {
  const report = withReviewRecord(implementedCloseReport()).replace(
    /^review_record: \{/m,
    "review_record: {broken",
  );
  const { result, decision } = validate(report);
  assert.deepEqual(result, {
    ok: false,
    actionTaken: "skipped_changed_since_review",
    reason: "review_record: the value is not JSON; fresh review required",
  });
  assert.equal(decision, undefined);
});

test("a maintainer proof override label replaces the reviewed proof", () => {
  const report = replaceFrontMatterValue(
    withReviewRecord(implementedCloseReport()),
    "labels",
    JSON.stringify(["proof: override"]),
  );
  assert.equal(validate(report).decision?.realBehaviorProof.status, "override");
});
