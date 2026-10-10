import assert from "node:assert/strict";
import test from "node:test";

import { renderReviewCommentFromReport } from "../dist/clawsweeper.js";
import { syncApplyPullRequestLabels } from "../dist/clawsweeper-apply-pull-request-labels.js";
import { createLabelMutationOperations } from "../dist/clawsweeper-label-mutations.js";
import { createLabelSyncOperations } from "../dist/clawsweeper-label-operations.js";
import { readReviewRecord, ReviewRecordFormatError } from "../dist/review-record.js";
import { createPullRequestPromotionFacts } from "../dist/clawsweeper-promotion-facts.js";
import { reviewDecisionParser } from "../dist/clawsweeper-decision-parser.js";
import { repositoryProfileFor } from "../dist/repository-profiles.js";
import { reviewSectionValue } from "../dist/clawsweeper-record-metadata.js";
import { reportRealBehaviorProofPolicy } from "../dist/clawsweeper-proof-policy.js";
import { pullRequestReviewReadinessFromReport } from "../dist/clawsweeper-report-comment-helpers.js";
import { ratingLabelForTier } from "../dist/clawsweeper-rating.js";
import {
  AUTHORITY_CHAIN_PROOF_MARKER,
  FEATURE_SHOWCASE_LABEL,
  PROOF_OVERRIDE_LABEL,
  PROOF_SUFFICIENT_LABEL,
} from "../dist/clawsweeper-policy.js";
import {
  detailsBody,
  item,
  realBehaviorProofReportSection,
  reviewReportFrontMatter,
  withReviewRecord,
} from "./helpers.ts";

// The report text selects P1 and the impact label. The review record selects P2 only.
function pullRequestReport(): string {
  return `${reviewReportFrontMatter({
    type: "pull_request",
    number: "74461",
    review_status: "complete",
    author: "contributor",
    author_association: "CONTRIBUTOR",
    labels: JSON.stringify([]),
    work_candidate: "none",
    triage_priority: "P1",
    impact_labels: JSON.stringify(["impact:message-loss"]),
    label_justifications: JSON.stringify([
      { label: "P1", reason: "The report text selects P1." },
      { label: "impact:message-loss", reason: "The report text selects message loss." },
    ]),
  })}

## Summary

Keep this PR open for maintainer review.

${realBehaviorProofReportSection({ status: "sufficient", evidenceKind: "terminal" })}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.8

Full review comments:

- none
`;
}

const recordedPullRequestDecision = {
  decision: "keep_open",
  closeReason: "none",
  triagePriority: "P2",
  impactLabels: [],
  mergeRiskLabels: [],
  maturityLabels: [],
  labelJustifications: [{ label: "P2", reason: "The review record selects P2." }],
  telegramVisibleProof: {
    status: "needed",
    summary: "Show the reply in a real Telegram chat.",
  },
};

test("PR review comment label details come from the review record", () => {
  const report = pullRequestReport();
  const legacyDetails = detailsBody(renderReviewCommentFromReport(report, "none"), "Label changes");
  assert.match(legacyDetails, /- add `P1`: The report text selects P1\./);

  const typed = withReviewRecord(report, recordedPullRequestDecision);
  const labelDetails = detailsBody(renderReviewCommentFromReport(typed, "none"), "Label changes");
  assert.match(labelDetails, /- add `P2`: The review record selects P2\./);
  assert.match(labelDetails, /- `P2`: The review record selects P2\./);
  assert.match(
    labelDetails,
    /- add `proof: telegram-e2e`: .*Show the reply in a real Telegram chat\./,
  );
  assert.doesNotMatch(labelDetails, /`P1`|impact:message-loss/);
});

test("a review record that does not read stops the review comment", () => {
  const typed = withReviewRecord(pullRequestReport(), recordedPullRequestDecision);
  const corrupt = typed.replace(/^review_record: \{/m, "review_record: {broken");
  assert.throws(() => renderReviewCommentFromReport(corrupt, "none"), ReviewRecordFormatError);
});

test("issue advisory label changes come from the review record", () => {
  const report = `${reviewReportFrontMatter({
    number: "9001",
    review_status: "complete",
    labels: JSON.stringify([]),
    item_category: "bug",
    reproduction_status: "unclear",
    reproduction_confidence: "low",
    work_candidate: "none",
  })}

## Summary

The issue reports a crash on startup.
`;
  const legacyDetails = detailsBody(renderReviewCommentFromReport(report, "none"), "Label changes");
  assert.match(legacyDetails, /- add `clawsweeper:needs-info`/);

  const typed = withReviewRecord(report, {
    decision: "keep_open",
    closeReason: "none",
    itemCategory: "bug",
    reproductionStatus: "reproduced",
    reproductionConfidence: "high",
  });
  const labelDetails = detailsBody(renderReviewCommentFromReport(typed, "none"), "Label changes");
  assert.match(labelDetails, /- add `clawsweeper:current-main-repro`/);
  assert.doesNotMatch(labelDetails, /clawsweeper:needs-info/);
});

function syncedPullRequestLabels(report: string): string[] {
  const commands: string[][] = [];
  const labelSync = createLabelSyncOperations(
    createLabelMutationOperations({
      ghJson: <T>(): T => [] as T,
      ghObservedMutationCommand: ({ args }) => {
        commands.push(args);
        return "";
      },
    }),
  );
  return syncApplyPullRequestLabels(
    {
      ...labelSync,
      syncStalePullRequestReviewLabels: () => assert.fail("the review head is current"),
    },
    {
      markdown: report,
      item: item({ kind: "pull_request", number: 74461, labels: [] }),
      number: 74461,
      currentItemContext: () => ({ comments: [], timeline: [] }),
      dryRun: false,
      labelSyncFreshEnough: () => true,
      staleReviewHead: null,
      onMutation: () => {},
    },
  ).labels;
}

test("apply PR label sync reads the Telegram proof label from the review record", () => {
  const report = pullRequestReport();
  assert.ok(!syncedPullRequestLabels(report).includes("proof: telegram-e2e"));
  const typed = syncedPullRequestLabels(withReviewRecord(report, recordedPullRequestDecision));
  assert.ok(typed.includes("proof: telegram-e2e"));
});

const readyDecision = {
  ...recordedPullRequestDecision,
  confidence: "high",
  overallCorrectness: "patch is correct",
  nextStep: { kind: "none", text: "" },
  realBehaviorProof: {
    status: "sufficient",
    evidenceKind: "recording",
    needsContributorAction: false,
    summary: "The saved review verified the real user flow.",
  },
  prRating: {
    proofTier: "A",
    patchTier: "A",
    overallTier: "A",
    summary: "The saved review is ready.",
    nextSteps: [],
  },
};

test("proof, rating, showcase, status and comment body share the saved decision", () => {
  const report = pullRequestReport().replace(
    "author_association: CONTRIBUTOR",
    "author_association: CONTRIBUTOR\npull_head_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  const typed = withReviewRecord(report, {
    ...readyDecision,
    summary: "Typed summary.",
    changeSummary: "Typed change.",
    itemCategory: "feature",
    requiresNewFeature: true,
    featureShowcase: { status: "showcase", reason: "Typed showcase rationale." },
    productReview: {
      kind: "feature",
      userProblem: "Typed user problem.",
      fixScope: "complete",
      worthIt: "yes",
      reason: "Typed product rationale.",
    },
  });
  const labels = syncedPullRequestLabels(typed);
  assert.ok(labels.includes(PROOF_SUFFICIENT_LABEL));
  assert.ok(labels.includes(ratingLabelForTier("A").name));
  assert.ok(labels.includes(FEATURE_SHOWCASE_LABEL));
  assert.equal(pullRequestReviewReadinessFromReport(typed).state, "ready");
  const comment = renderReviewCommentFromReport(typed, "none");
  assert.match(comment, /Typed change\./);
  assert.match(comment, /Typed summary\./);
  assert.match(comment, /Typed user problem\./);
  assert.match(comment, /The saved review verified the real user flow\./);
  assert.doesNotMatch(comment, /Keep this PR open for maintainer review/);
});

test("typed findings, product and security block the same readiness used by labels", () => {
  const typed = withReviewRecord(pullRequestReport(), {
    ...readyDecision,
    reviewFindings: [
      {
        title: "Typed finding",
        body: "The saved finding must be fixed.",
        priority: 1,
        confidenceScore: 0.9,
        file: "src/example.ts",
        lineStart: 1,
        lineEnd: 1,
      },
    ],
    securityReview: {
      status: "needs_attention",
      summary: "Typed security blocker.",
      concerns: [],
    },
    productReview: {
      kind: "feature",
      userProblem: "No supported use case.",
      fixScope: "complete",
      worthIt: "no",
      reason: "Typed product blocker.",
    },
  });
  const readiness = pullRequestReviewReadinessFromReport(typed);
  assert.equal(readiness.state, "blocked");
  const comment = renderReviewCommentFromReport(typed, "none");
  assert.match(comment, /Typed finding/);
  assert.match(comment, /Typed security blocker/);
  assert.match(comment, /Typed product blocker/);
});

test("host proof rules retain overrides, author exemptions, empty summaries and authority markers", () => {
  const missing = {
    status: "missing",
    summary: "Typed proof request.",
    evidenceKind: "none",
    needsContributorAction: true,
    dataModelCompatibility: "insufficient",
  };
  const report = pullRequestReport();
  const typed = (source: string, proof = missing) =>
    withReviewRecord(source, { ...readyDecision, realBehaviorProof: proof });
  assert.equal(reportRealBehaviorProofPolicy(typed(report)).assessment.status, "missing");
  const maintainer = report.replace(
    "author_association: CONTRIBUTOR",
    "author_association: MEMBER",
  );
  assert.equal(
    reportRealBehaviorProofPolicy(typed(maintainer)).assessment.status,
    "not_applicable",
  );
  const bot = report.replace("author: contributor", "author: dependabot[bot]");
  assert.equal(reportRealBehaviorProofPolicy(typed(bot)).assessment.status, "not_applicable");
  const override = report.replace(
    "labels: []",
    `labels: ${JSON.stringify([PROOF_OVERRIDE_LABEL])}`,
  );
  const overridden = reportRealBehaviorProofPolicy(typed(override));
  assert.equal(overridden.assessment.status, "override");
  assert.equal(overridden.assessment.dataModelCompatibility, "insufficient");
  assert.equal(overridden.proofBlocksMerge, false);
  const empty = reportRealBehaviorProofPolicy(typed(report, { ...missing, summary: "" }));
  assert.equal(empty.assessment.status, "missing");
  assert.match(empty.assessment.summary, /No after-fix real behavior proof was recorded/);
  const authority = reportRealBehaviorProofPolicy(
    typed(maintainer, {
      ...missing,
      status: "not_applicable",
      needsContributorAction: false,
      summary: `  ${AUTHORITY_CHAIN_PROOF_MARKER} verify the changed authority.`,
    }),
  );
  assert.equal(authority.required, true);
  assert.equal(authority.proofBlocksMerge, true);
});

test("typed close disposition and maintainer decision control comment choice", () => {
  const report = pullRequestReport();
  const close = withReviewRecord(report, {
    ...readyDecision,
    decision: "close",
    closeReason: "implemented_on_main",
    summary: "The saved decision closes this item.",
  });
  assert.match(renderReviewCommentFromReport(close, "implemented_on_main"), /already implemented/);
  const keep = withReviewRecord(report.replace("decision: keep_open", "decision: close"), {
    ...readyDecision,
    summary: "The saved decision keeps this item open.",
  });
  assert.doesNotMatch(
    renderReviewCommentFromReport(keep, "implemented_on_main"),
    /already implemented/,
  );
  const needsOwner = withReviewRecord(report, {
    ...readyDecision,
    decision: "close",
    closeReason: "implemented_on_main",
    maintainerDecision: {
      required: true,
      kind: "product_direction",
      question: "Typed owner question?",
      rationale: "Typed owner rationale.",
      options: [
        { title: "Keep", body: "Keep the change.", recommended: true },
        { title: "Close", body: "Close the change.", recommended: false },
      ],
      likelyOwner: {
        person: "@alice",
        reason: "Owns the product direction.",
        confidence: "high",
      },
    },
  });
  const comment = renderReviewCommentFromReport(needsOwner, "implemented_on_main");
  assert.match(comment, /Typed owner question/);
  assert.doesNotMatch(comment, /already implemented/);
});

test("unreadable records fail closed for proof and label synchronization", () => {
  const report = withReviewRecord(pullRequestReport(), readyDecision).replace(
    /^review_record: \{/m,
    "review_record: {broken",
  );
  assert.throws(() => reportRealBehaviorProofPolicy(report), ReviewRecordFormatError);
  assert.throws(() => syncedPullRequestLabels(report), ReviewRecordFormatError);
  assert.equal(pullRequestReviewReadinessFromReport(report).normalizationFailed, true);
});

test("typed findings drive the repair marker with the same readiness as the comment", () => {
  const report = pullRequestReport()
    .replace("labels: []", 'labels: ["clawsweeper:autofix"]')
    .replace(
      "author_association: CONTRIBUTOR",
      "author_association: CONTRIBUTOR\npull_head_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
  const typed = withReviewRecord(report, {
    ...readyDecision,
    reviewFindings: [
      {
        title: "Typed repair",
        body: "Repair this saved finding.",
        priority: 1,
        confidenceScore: 0.9,
        file: "src/example.ts",
        lineStart: 1,
        lineEnd: 1,
      },
    ],
  });
  assert.equal(pullRequestReviewReadinessFromReport(typed).state, "needs-changes");
  const comment = renderReviewCommentFromReport(typed, "none");
  assert.match(comment, /clawsweeper-action:fix-required/);
  assert.doesNotMatch(comment, /hold=blocked findings=0/);
});

test("no-diff promotion renders and stores the promoted typed decision", () => {
  const { upgradeNoDiffPullRequestReport } = createPullRequestPromotionFacts({
    defaultRootCauseCluster: reviewDecisionParser.defaultRootCauseCluster,
    targetProfile: () => repositoryProfileFor("openclaw/openclaw"),
  } as Parameters<typeof createPullRequestPromotionFacts>[0]);
  const source = withReviewRecord(pullRequestReport(), {
    ...readyDecision,
    summary: "Keep this PR open.",
    bestSolution: "Continue the old review.",
    evidence: [],
  });
  const promoted = upgradeNoDiffPullRequestReport(
    source,
    item({ kind: "pull_request", number: 74461 }),
  );
  const comment = reviewSectionValue(promoted, "closeComment");
  assert.match(comment, /GitHub reports no changed files/);
  assert.match(comment, /changed_files: 0/);
  assert.doesNotMatch(comment, /Keep this PR open|Continue the old review/);
  assert.equal(readReviewRecord(promoted)?.decision.closeComment, comment);
});
