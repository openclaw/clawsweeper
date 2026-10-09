import assert from "node:assert/strict";
import test from "node:test";

import { renderReviewCommentFromReport } from "../dist/clawsweeper.js";
import { syncApplyPullRequestLabels } from "../dist/clawsweeper-apply-pull-request-labels.js";
import { createLabelMutationOperations } from "../dist/clawsweeper-label-mutations.js";
import { createLabelSyncOperations } from "../dist/clawsweeper-label-operations.js";
import { ReviewRecordFormatError } from "../dist/review-record.js";
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
