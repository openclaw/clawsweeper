import assert from "node:assert/strict";
import test from "node:test";

import { validateCloseDecision } from "../dist/clawsweeper.js";
import { validateReportClose } from "../dist/clawsweeper-apply-close-decision.js";
import { replaceFrontMatterValue } from "../dist/report-front-matter.js";
import type { CloseReason, Decision } from "../src/clawsweeper-types.ts";
import { closeDecision, implementedCloseReport, withReviewRecord } from "./helpers.ts";

const issue = { repo: "openclaw/clawsweeper", kind: "issue" as const, labels: [] };

function validate(markdown: string, legacy?: Decision) {
  const legacyCalls: CloseReason[] = [];
  const validated: Decision[] = [];
  const result = validateReportClose(
    {
      reportDecision: (_markdown: string, closeReason: CloseReason) => {
        legacyCalls.push(closeReason);
        assert.ok(legacy, "a report with a review record must not read the report text");
        return legacy;
      },
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
  return { result, legacyCalls, decision: validated[0] };
}

test("the apply validates the close from the review record", () => {
  const report = withReviewRecord(implementedCloseReport(), {
    summary: "The record summary.",
    closeComment: "",
  });
  const { result, legacyCalls, decision } = validate(report);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(legacyCalls, []);
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

test("a report without a review record reads its decision from the report text", () => {
  const legacy = closeDecision({ summary: "From the report text." }) as Decision;
  const { result, legacyCalls, decision } = validate(implementedCloseReport(), legacy);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(legacyCalls, ["implemented_on_main"]);
  assert.equal(decision?.summary, "From the report text.");
});

test("a review record that does not read blocks the close and asks for a fresh review", () => {
  const report = withReviewRecord(implementedCloseReport()).replace(
    /^review_record: \{/m,
    "review_record: {broken",
  );
  const { result, legacyCalls, decision } = validate(report, closeDecision() as Decision);
  assert.deepEqual(result, {
    ok: false,
    actionTaken: "skipped_changed_since_review",
    reason: "review_record: the value is not JSON; fresh review required",
  });
  assert.deepEqual(legacyCalls, []);
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
