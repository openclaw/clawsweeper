import assert from "node:assert/strict";
import test from "node:test";
import { hasDataModelUpgradeProof } from "../dist/clawsweeper-change-detection.js";
import {
  renderReviewCommentFromReport,
  reviewAutomationMarkersFromReport,
} from "../dist/clawsweeper.js";
import {
  compatibilityFixture,
  compatibilityReport,
  verifiedCompatibility,
} from "./compatibility-proof-fixture.ts";

const structuralNegations = [
  compatibilityFixture.structuralNegation,
  "No schema or migration changes are introduced.",
  "No database schema or migration changes were introduced.",
  "No persistent schema or migration changes were introduced.",
  "No migration, schema, or serialized format changes.",
  "No persistent contract changes.",
  "No data-model or storage migration changes were included.",
  "No stored schema, persistent format and data migration changes made.",
  "- No migration changes.\n",
];

for (const negation of structuralNegations) {
  test("neutral standalone structural statement: " + negation, () => {
    assert.equal(hasDataModelUpgradeProof(negation + " " + verifiedCompatibility), true);
    assert.equal(hasDataModelUpgradeProof(negation), false);
    // Unrelated verification cannot borrow the removed migration noun.
    assert.equal(hasDataModelUpgradeProof(negation + " UI rendering was verified."), false);
  });
}

const blockedProofs = [
  "No migration proof was supplied.",
  "Missing upgrade compatibility tests.",
  "Without compatibility verification.",
  "Upgrade compatibility was not tested.",
  "Existing state was never verified.",
  "Migration verification is required before merge.",
  "Migration tests remain pending.",
  "Upgrade compatibility tests are planned.",
  "Existing data preservation is unimplemented.",
  "Existing state should remain compatible.",
];

for (const missing of blockedProofs) {
  test("original proof blocker survives neutral clause: " + missing, () => {
    const assessment = verifiedCompatibility + " " + missing;
    assert.equal(hasDataModelUpgradeProof(assessment), false);
    assert.equal(
      hasDataModelUpgradeProof(compatibilityFixture.structuralNegation + " " + assessment),
      false,
    );
  });
}

for (const incomplete of [
  "No migration changes were tested.",
  "No schema or migration changes were introduced without compatibility verification.",
  "No migration changes or compatibility proof were supplied.",
  "No migration changes are planned.",
  "No migration changes are not tested.",
]) {
  test("do not remove partial or qualified clauses: " + incomplete, () => {
    assert.equal(hasDataModelUpgradeProof(incomplete + " " + verifiedCompatibility), false);
  });
}

function assertCompatibilityDecision(assessment: string, accepted: boolean): void {
  const report = compatibilityReport(assessment);
  assert.equal(hasDataModelUpgradeProof(assessment), accepted, assessment);
  assert.equal(
    renderReviewCommentFromReport(report, "none").includes("Add data-model compatibility proof"),
    !accepted,
    assessment,
  );
  assert.equal(
    reviewAutomationMarkersFromReport(report).includes("clawsweeper-review-state:blocked"),
    !accepted,
    assessment,
  );
}

// These period-scoped units deliberately retain the original conservative decision.
// Do not infer independent neutral clauses from conjunctions or layout alone.
for (const continuation of [
  ", but tests remain pending.",
  " and compatibility was not tested.",
  ", and proof is missing.",
  ", but no tests were run.",
  ", and no proof was supplied.",
  " but no verification was supplied.",
  " and tests were not run.",
  ", but tests were not executed.",
  "; no proof was supplied.",
  "\nno tests were run.",
  "\n\nno proof was supplied.",
  "\n- tests were not executed.",
]) {
  test("coordinated or continued absence remains blocked: " + continuation, () => {
    assertCompatibilityDecision(
      "No migration changes were introduced" + continuation + " " + verifiedCompatibility,
      false,
    );
  });
}

test("independent positive evidence does not normalize a coordinated declaration", () => {
  for (const declaration of [
    "No schema or migration changes are introduced, and ",
    "No migration or schema changes were made, but ",
    "No schema or migration changes were introduced and ",
    "No migration changes were made but ",
  ]) {
    assertCompatibilityDecision(declaration + verifiedCompatibility, false);
  }
});

test("standalone structural nouns cannot supply positive proof", () => {
  for (const continuation of [".", ", and UI rendering was verified."]) {
    assertCompatibilityDecision("No migration changes were introduced" + continuation, false);
  }
});

for (const marker of ["-", "*", "+", "1.", "2)"]) {
  test("Markdown markers require a complete punctuated statement: " + marker, () => {
    for (const prefix of [marker + " ", "Assessment.\n" + marker + " "]) {
      const neutral = prefix + "No migration changes were introduced";
      assertCompatibilityDecision(neutral + ".\n" + marker + " " + verifiedCompatibility, true);
      assertCompatibilityDecision(neutral, false);
      assertCompatibilityDecision(neutral + ", and UI rendering was verified.", false);
      assertCompatibilityDecision(
        neutral + ", but no tests were run. " + verifiedCompatibility,
        false,
      );
      assertCompatibilityDecision(
        prefix + "No migration changes\nwere tested. " + verifiedCompatibility,
        false,
      );
    }
  });
}

test("numbered marker periods do not start statements after bare headers", () => {
  for (const marker of ["1.", "12."]) {
    assertCompatibilityDecision(
      "Assessment\n" + marker + " No migration changes. " + verifiedCompatibility,
      false,
    );
  }
});

for (const prefix of ["1. ", "Assessment.\n1. "]) {
  test("numbered declarations retain explicit statement boundaries: " + prefix, () => {
    assertCompatibilityDecision(prefix + "No migration changes. " + verifiedCompatibility, true);
  });
}

test("numbered statement boundaries do not remove qualified negatives", () => {
  for (const prefix of ["1. ", "Assessment.\n1. "]) {
    assertCompatibilityDecision(
      prefix + "No migration changes were tested. " + verifiedCompatibility,
      false,
    );
  }
});

for (const newline of ["\n", "\r\n"]) {
  test("newline continuations preserve period-scoped negatives: " + JSON.stringify(newline), () => {
    for (const continuation of ["were tested.", "without compatibility verification."]) {
      assertCompatibilityDecision(
        "No migration changes" + newline + continuation + " " + verifiedCompatibility,
        false,
      );
    }
  });
}

test("coordination, semicolons and layout do not end a statement", () => {
  for (const separator of [
    "; ",
    ";\r\n",
    ", and ",
    " and ",
    ", but ",
    " but ",
    "\nand ",
    ",\r\nbut ",
    "\n",
    "\r\n",
    "\n\n",
    "\r\n \r\n",
    "\n- ",
    "\r\n* ",
    "\n+ ",
    "\n1. ",
    "\n2) ",
  ]) {
    assertCompatibilityDecision(
      "No migration changes were introduced" + separator + verifiedCompatibility,
      false,
    );
  }
  assertCompatibilityDecision(
    "No schema changes; no migration changes. " + verifiedCompatibility,
    false,
  );
});

test("coordination, semicolons and layout do not start a statement", () => {
  for (const prefix of [
    "Assessment, and ",
    "Assessment but ",
    "Assessment; ",
    "Assessment:\n",
    "Assessment\n\n",
    "Assessment\n- ",
    "Assessment\n* ",
    "Assessment\n+ ",
    "Assessment\n2) ",
  ]) {
    assertCompatibilityDecision(prefix + "No migration changes. " + verifiedCompatibility, false);
  }
});

test("only periods or actual EOF finish standalone statements", () => {
  for (const separator of [". ", ".\n", ".\r\n\r\n", " \n.\n- "]) {
    const neutral = "No migration changes were introduced";
    assertCompatibilityDecision(neutral + separator + verifiedCompatibility, true);
    assertCompatibilityDecision(
      neutral + separator + "No upgrade proof. " + verifiedCompatibility,
      false,
    );
  }
  for (const suffix of ["", " ", "\n", "\r\n\r\n"]) {
    assertCompatibilityDecision(verifiedCompatibility + " No migration changes" + suffix, true);
    assertCompatibilityDecision("No migration changes" + suffix, false);
  }
  assertCompatibilityDecision(
    "No migration changes. No schema and migration changes. " + verifiedCompatibility,
    true,
  );
});

test("no-migration-required retains its original special handling", () => {
  assert.equal(hasDataModelUpgradeProof("No data migration is required."), false);
  assert.equal(
    hasDataModelUpgradeProof("No data migration is required; compatibility was verified."),
    true,
  );
  assert.equal(
    hasDataModelUpgradeProof("No data migration is required; compatibility proof is missing."),
    false,
  );
});

test("standalone-statement invariance does not broaden original positive vocabulary", () => {
  for (const text of [
    "",
    "UI rendering was verified.",
    "Existing state was preserved.",
    "Migration was tested.",
    "Upgrade completed successfully.",
    "Existing state was restored.",
    ...blockedProofs,
  ]) {
    assert.equal(
      hasDataModelUpgradeProof(compatibilityFixture.structuralNegation + " " + text),
      hasDataModelUpgradeProof(text),
      text,
    );
  }
});

test("captured prose does not cancel the independently recorded assessment", () => {
  const report = compatibilityReport(
    verifiedCompatibility,
    compatibilityFixture.structuralNegation + " " + compatibilityFixture.evidence,
  );
  const comment = renderReviewCommentFromReport(report, "none");
  assert.match(comment, /Migration or upgrade compatibility proof is recorded/);
  assert.doesNotMatch(comment, /Add data-model compatibility proof/);
  assert.match(comment, /earlier-candidate evidence, not a current-head Docker rerun/);
  assert.match(comment, /migration\/backfill\/repair: src\/commands\/doctor-lint.ts/);
  assert.doesNotMatch(
    reviewAutomationMarkersFromReport(report),
    /clawsweeper-review-state:blocked/,
  );
});

test("rendered checklist still blocks explicit untested compatibility", () => {
  const report = compatibilityReport(
    verifiedCompatibility + " Upgrade compatibility was not tested.",
    compatibilityFixture.structuralNegation,
  );
  assert.match(renderReviewCommentFromReport(report, "none"), /Add data-model compatibility proof/);
  assert.match(reviewAutomationMarkersFromReport(report), /clawsweeper-review-state:blocked/);
});
