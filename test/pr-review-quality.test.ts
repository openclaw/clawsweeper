import assert from "node:assert/strict";
import test from "node:test";
import {
  parseDecision,
  renderReviewCommentFromReport,
  reviewAutomationMarkersFromReport,
} from "../dist/clawsweeper.js";
import { createRecordMetadata } from "../dist/clawsweeper-record-metadata.js";
import { createReportHelpers } from "../dist/clawsweeper-report-helpers.js";
import {
  createReportParser,
  reportChangeExample,
  reportProductReview,
  reportProvenance,
  reportTestingReview,
} from "../dist/clawsweeper-report-parser.js";
import type {
  PrRating,
  ProductReview,
  ProvenanceEntry,
  RealBehaviorProof,
  TestingReview,
} from "../src/clawsweeper-types.ts";
import {
  compatibilityReport,
  generatedCompatibilityReport,
} from "./compatibility-proof-fixture.ts";
import { closeDecision, item, prRatingReportSection } from "./helpers.ts";

const worthyProduct: ProductReview = {
  kind: "bug_fix",
  userProblem: "Users lose their draft when the page reloads.",
  fixScope: "complete",
  worthIt: "yes",
  reason: "A clear user problem with a narrow fix.",
};
const shippedTesting: TestingReview = {
  proofPath: "shipped_entry_point",
  addedTestFiles: 1,
  lowValueTests: [],
  missingE2e: "",
};
const sufficientProof: RealBehaviorProof = {
  status: "sufficient",
  summary: "A terminal transcript from the real CLI shows the fixed behavior.",
  evidenceKind: "terminal",
  needsContributorAction: false,
};
const notApplicableReview = {
  productReview: {
    kind: "not_applicable",
    userProblem: "",
    fixScope: "not_applicable",
    worthIt: "not_applicable",
    reason: "",
  } satisfies ProductReview,
  provenance: [] as ProvenanceEntry[],
  testingReview: {
    proofPath: "not_applicable",
    addedTestFiles: 0,
    lowValueTests: [],
    missingE2e: "",
  } satisfies TestingReview,
};
const topRating: PrRating = {
  proofTier: "S",
  patchTier: "S",
  overallTier: "S",
  summary: "Exceptional proof and a clean patch.",
  nextSteps: [],
};
const overridesIntent: ProvenanceEntry = {
  area: "src/session/reload.ts",
  introducedBy: "https://github.com/example/repo/pull/12",
  originalReason: "Reload drops drafts so stale drafts cannot overwrite server state.",
  verdict: "overrides_without_reason",
};
const lowValueTest = (index: number) => ({
  file: `test/reload-${index}.test.ts`,
  reason: "Asserts mock call counts instead of behavior.",
});

function tiers(rating: PrRating) {
  return `${rating.proofTier}/${rating.patchTier}/${rating.overallTier}`;
}

function pullRequestDecision(overrides: Record<string, unknown> = {}) {
  return closeDecision({
    decision: "keep_open",
    closeReason: "none",
    overallCorrectness: "patch is correct",
    productReview: worthyProduct,
    testingReview: { ...shippedTesting, proofPath: "in_process_harness" },
    realBehaviorProof: sufficientProof,
    prRating: { ...topRating, proofTier: "A", patchTier: "A", overallTier: "A" },
    ...overrides,
  });
}

test("decision parsing keeps the reviewer's rating instead of capping it in code", () => {
  const pull = parseDecision(pullRequestDecision(), item({ kind: "pull_request" }));
  assert.equal(tiers(pull.prRating), "A/A/A");
});

test("decision parsing rejects invalid product, provenance, and testing values", () => {
  const pr = item({ kind: "pull_request" });
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ productReview: { ...worthyProduct, worthIt: "maybe" } }, /productReview\.worthIt/],
    [{ productReview: { ...worthyProduct, kind: "bug" } }, /productReview\.kind/],
    [{ productReview: { ...worthyProduct, fixScope: "most" } }, /productReview\.fixScope/],
    [{ productReview: { ...worthyProduct, extra: true } }, /productReview has unexpected keys/],
    [{ provenance: [{ ...overridesIntent, verdict: "fine" }] }, /provenance\[0\]\.verdict/],
    [{ provenance: {} }, /provenance must be an array/],
    [{ testingReview: { ...shippedTesting, proofPath: "e2e" } }, /testingReview\.proofPath/],
    [{ testingReview: { ...shippedTesting, addedTestFiles: -1 } }, /addedTestFiles/],
    [{ testingReview: { ...shippedTesting, addedTestFiles: 1.5 } }, /addedTestFiles/],
    [
      { testingReview: { ...shippedTesting, lowValueTests: [{ file: "a.test.ts" }] } },
      /lowValueTests\[0\]\.reason/,
    ],
    [{ testingReview: undefined }, /testingReview must be an object/],
  ];
  for (const [overrides, error] of cases) {
    assert.throws(() => parseDecision(pullRequestDecision(overrides), pr), error);
  }
});

const reportParser = createReportParser({
  ...createRecordMetadata({} as never),
  ...createReportHelpers({
    OWNED_REVIEW_SECTION_HEADINGS: new Set(),
    parseBacktickLocation: () => null,
  }),
  isDocsOnlyPullRequestReport: () => false,
  isExternalPullRequestReport: () => true,
} as Parameters<typeof createReportParser>[0]);

test("report round trip preserves product, provenance, and testing reviews", () => {
  const testingReview = {
    proofPath: "in_process_harness",
    addedTestFiles: 3,
    lowValueTests: [1, 2].map(lowValueTest),
    missingE2e: "Reload the real web UI with an unsaved draft.",
  } satisfies TestingReview;
  const provenance = [
    overridesIntent,
    {
      area: "src/session/store.ts",
      introducedBy: "unknown",
      originalReason: "",
      verdict: "unknown",
    } satisfies ProvenanceEntry,
  ];
  const productReview = { ...worthyProduct, kind: "preference", worthIt: "no" } as const;
  const changeExample = {
    scenario: "A user reloads the page with an unsaved draft",
    before: "The draft is lost.",
    after: "The draft is restored.",
  };
  const report = generatedCompatibilityReport("sufficient", {
    changeExample: { ...changeExample, before: "The draft\n  is lost." },
    productReview: { ...productReview, reason: "Works as designed;\nthe user prefers a change." },
    provenance,
    testingReview,
  });
  assert.deepEqual(reportChangeExample(report), changeExample);
  assert.deepEqual(reportProductReview(report), {
    ...productReview,
    reason: "Works as designed; the user prefers a change.",
  });
  assert.deepEqual(reportProvenance(report), provenance);
  assert.deepEqual(reportTestingReview(report), testingReview);
  for (const line of [
    "product_kind: preference",
    "product_worth: no",
    "product_fix_scope: complete",
    "testing_proof_path: in_process_harness",
    "low_value_tests: 2",
    "provenance_overrides_without_reason: 1",
  ]) {
    assert.ok(report.includes(`\n${line}\n`), line);
  }
});

test("old reports read as not applicable and keep their stored rating", () => {
  const old = `${compatibilityReport({
    metadata: { pr_rating_overall: "A", pr_rating_proof: "A", pr_rating_patch: "A" },
  })}\n${prRatingReportSection({ overallTier: "A", proofTier: "A", patchTier: "A" })}`;
  assert.deepEqual(reportChangeExample(old), { scenario: "", before: "", after: "" });
  assert.deepEqual(reportProductReview(old), notApplicableReview.productReview);
  assert.deepEqual(reportProvenance(old), []);
  assert.deepEqual(reportTestingReview(old), notApplicableReview.testingReview);
  assert.equal(tiers(reportParser.reportPrRating(old)), "A/A/A");
});

function readiness(overrides: Record<string, unknown>) {
  const report = generatedCompatibilityReport("sufficient", {
    productReview: worthyProduct,
    testingReview: shippedTesting,
    ...overrides,
  });
  const comment = renderReviewCommentFromReport(report, "none");
  const markers = reviewAutomationMarkersFromReport(report);
  return {
    comment,
    passes: markers.includes("clawsweeper-verdict:pass"),
    state: markers.match(/clawsweeper-review-state:([a-z-]+)/)?.[1],
  };
}

test("a worthwhile, proven PR stays ready", () => {
  const ready = readiness({});
  assert.match(ready.comment, /## Before merge\s+None\./);
  assert.equal(ready.passes, true);
  assert.equal(ready.state, "ready");
});

test("product verdicts block merge readiness", () => {
  const notWorth = readiness({
    productReview: { ...worthyProduct, worthIt: "no", reason: "Niche preference." },
  });
  assert.match(notWorth.comment, /\*\*Product: not worth merging\*\* - Niche preference\./);
  assert.equal(notWorth.passes, false);
  assert.equal(notWorth.state, "blocked");

  const productCall = readiness({
    productReview: { ...worthyProduct, worthIt: "needs_maintainer", reason: "Adds a new default." },
  });
  assert.match(productCall.comment, /\*\*Product call needed\*\* - Adds a new default\./);
  assert.equal(productCall.passes, false);
  assert.equal(productCall.state, "blocked");
});

test("a product call with a maintainer decision packet asks the owner once", () => {
  const result = readiness({
    productReview: { ...worthyProduct, worthIt: "needs_maintainer", reason: "Adds a new setting." },
    maintainerDecision: {
      required: true,
      kind: "product_direction",
      question: "Should the product add this setting?",
      rationale: "No maintainer has accepted the new setting.",
      options: [
        { title: "Accept the setting", body: "Ship it default-off.", recommended: true },
        { title: "Decline the setting", body: "Keep current behavior.", recommended: false },
      ],
      likelyOwner: { person: "unknown", reason: "Owner is not identified.", confidence: "low" },
    },
  });
  assert.match(result.comment, /Resolve maintainer decision/);
  assert.doesNotMatch(result.comment, /Product call needed/);
  assert.equal(result.state, "blocked");
});

test("an unexplained provenance override needs changes, not a block", () => {
  const result = readiness({ provenance: [overridesIntent] });
  assert.match(
    result.comment,
    /\*\*Explain or restore the original intent of src\/session\/reload\.ts\*\* - https:\/\/github\.com\/example\/repo\/pull\/12: Reload drops drafts/,
  );
  assert.equal(result.passes, false);
  assert.equal(result.state, "needs-changes");
});

test("low-value tests are listed without blocking readiness", () => {
  const result = readiness({
    testingReview: { ...shippedTesting, lowValueTests: [lowValueTest(1)] },
  });
  assert.match(result.comment, /## Before merge\s+None\./);
  assert.equal(result.state, "ready");
});
