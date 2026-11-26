import { renderReviewCommentFromReport } from "../dist/clawsweeper-report-comment-presentation.js";
import assert from "node:assert/strict";
import test from "node:test";
import { parseDecision, reviewAutomationMarkersFromReport } from "../dist/clawsweeper.js";
import { reportReviewDecision } from "../dist/report-review-decision.js";
import { updateReviewRecordDecision } from "../dist/review-record.js";
import type {
  PrRating,
  ProductReview,
  ProvenanceEntry,
  RealBehaviorProof,
  TestingReview,
} from "../src/clawsweeper-types.ts";
import { generatedCompatibilityReport } from "./compatibility-proof-fixture.ts";
import { closeDecision, item } from "./helpers.ts";

const worthyProduct: ProductReview = {
  kind: "bug_fix",
  userProblem: "Users lose their draft when the page reloads.",
  fixScope: "complete",
  worthIt: "yes",
  reason: "A clear user problem with a narrow fix.",
};
const shippedTesting: TestingReview = {
  proofPath: "shipped_entry_point",
  lowValueTests: [],
  missingE2e: "",
};
const sufficientProof: RealBehaviorProof = {
  status: "sufficient",
  summary: "A terminal transcript from the real CLI shows the fixed behavior.",
  evidenceKind: "terminal",
  needsContributorAction: false,
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
const behavior = {
  behavior: "Reload returns the stored draft.",
  fault: "Return an empty draft for a populated session.",
  survivor: {
    file: "test/reload.test.ts",
    line: 42,
    assertion: 'expect(result.draft).toBe("saved");',
    failure: "The original draft must be returned.",
    inputs: [
      { file: "test/reload.test.ts", lineStart: 40, lineEnd: 41, sourceLine: 'save("saved");' },
    ],
  },
};
const lowValueTest = (index: number) => ({
  file: `test/reload-${index}.test.ts`,
  lineStart: 8,
  lineEnd: 8,
  reason: "The second draft-value assertion repeats the reload contract.",
  behaviors: [behavior],
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
    [
      { testingReview: { ...shippedTesting, lowValueTests: [{ file: "a.test.ts" }] } },
      /lowValueTests\[0\]\.reason/,
    ],
    ...[[], [{ ...behavior, fault: " " }], [{ ...behavior, survivor: {} }]].map(
      (behaviors): [Record<string, unknown>, RegExp] => [
        {
          testingReview: { ...shippedTesting, lowValueTests: [{ ...lowValueTest(1), behaviors }] },
        },
        /lowValueTests\[0\]\.behaviors/,
      ],
    ),
    ...[
      undefined,
      { check: "test/reload.test.ts:42", regression: "Both fail." },
      { notWorthTesting: "Private detail." },
    ].map((survivor): [Record<string, unknown>, RegExp] => [
      {
        testingReview: {
          ...shippedTesting,
          lowValueTests: [
            { file: "a.test.ts", reason: "Remove it", ...(survivor ? { survivor } : {}) },
          ],
        },
      },
      /lowValueTests\[0\]/,
    ]),
    [{ testingReview: undefined }, /testingReview must be an object/],
  ];
  for (const [overrides, error] of cases) {
    assert.throws(() => parseDecision(pullRequestDecision(overrides), pr), error);
  }
});

test("report round trip preserves product, provenance, and testing reviews", () => {
  const testingReview = {
    proofPath: "in_process_harness",
    lowValueTests: [lowValueTest(1), lowValueTest(2)],
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
  const decision = reportReviewDecision(report);
  assert.deepEqual(decision.changeExample, changeExample);
  assert.deepEqual(decision.productReview, {
    ...productReview,
    reason: "Works as designed; the user prefers a change.",
  });
  assert.deepEqual(decision.provenance, provenance);
  assert.deepEqual(decision.testingReview, testingReview);
  const legacyCut = {
    file: "test/reload-3.test.ts",
    reason: "Remove the cache-helper call count.",
  };
  for (const cut of [
    legacyCut,
    { ...legacyCut, survivor: { check: "test/reload.test.ts:42", regression: "Drops the draft." } },
    { ...legacyCut, survivor: { notWorthTesting: "Private detail." } },
  ]) {
    const legacyReport = updateReviewRecordDecision(report, () => ({
      testingReview: { ...testingReview, lowValueTests: [cut] },
    }));
    assert.deepEqual(reportReviewDecision(legacyReport).testingReview.lowValueTests, [cut]);
  }
  const comment = renderReviewCommentFromReport(report, "none");
  for (const field of [
    behavior.behavior,
    behavior.fault,
    "test/reload.test.ts:42",
    behavior.survivor.failure,
  ]) {
    assert.ok(comment.includes(field));
    assert.ok(report.includes(field));
  }
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

test("one uncovered behavior withholds only its own deletion", () => {
  const cut = lowValueTest(1);
  const testingReview = {
    ...shippedTesting,
    lowValueTests: [
      {
        ...cut,
        behaviors: [
          behavior,
          {
            behavior: "An empty session has no draft.",
            fault: "Return the last session's draft.",
            survivor: null,
          },
        ],
      },
      lowValueTest(2),
    ],
  };
  const report = generatedCompatibilityReport("sufficient", { testingReview });
  assert.deepEqual(reportReviewDecision(report).testingReview.lowValueTests, [lowValueTest(2)]);
  const comment = renderReviewCommentFromReport(report, "none");
  assert.doesNotMatch(comment, /reload-1\.test/);
  assert.match(comment, /reload-2\.test/);
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
    stateHold: markers.match(/clawsweeper-review-state:[a-z-]+[^>]*\bhold=([a-z_]+)/)?.[1],
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
      likelyOwner: { person: "unknown" },
    },
  });
  assert.match(result.comment, /## Decision needed/);
  assert.match(result.comment, /⏳ \*\*Ready, awaiting maintainer decision\*\*/);
  assert.doesNotMatch(result.comment, /Product call needed|Resolve maintainer decision/);
  // Presentation says awaiting; the v1 wire state stays blocked with the hold attribute.
  assert.equal(result.state, "blocked");
  assert.equal(result.stateHold, "maintainer_decision");
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
