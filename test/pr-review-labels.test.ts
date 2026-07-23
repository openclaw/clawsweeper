import assert from "node:assert/strict";
import test from "node:test";

import {
  renderReviewCommentFromReport,
  reviewAutomationMarkersFromReport,
} from "../dist/clawsweeper.js";
import {
  detailsBody,
  prRatingReportSection,
  realBehaviorProofReportSection,
  reportFrontMatter,
} from "./helpers.ts";

test("sufficient real behavior proof allows automerge pass markers", () => {
  const report = `${reportFrontMatter({
    type: "pull_request",
    number: "74459",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    author: "contributor",
    author_association: "CONTRIBUTOR",
    labels: JSON.stringify(["clawsweeper:automerge"]),
    work_candidate: "none",
    pull_head_sha: "abc123def456",
  })}

## Summary

Keep this focused PR open for automerge.

## What This Changes

Fixes the gateway status output.

## Best Possible Solution

Merge after required checks are green.

${realBehaviorProofReportSection()}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;

  const comment = renderReviewCommentFromReport(report, "none", {
    prStatusKind: "ready_for_maintainer_look",
  });
  const markers = reviewAutomationMarkersFromReport(report);

  assert.match(comment, /## Merge readiness/);
  assert.match(comment, /\| \*\*Overall readiness\*\* \| 🦞 diamond lobster \*\*\(5\/6\)\*\* \|/);
  assert.match(comment, /\| \*\*Proof confidence\*\* \| 🦞 diamond lobster \*\*\(5\/6\)\*\* \|/);
  assert.match(comment, /\| \*\*Patch quality\*\* \| 🦞 diamond lobster \*\*\(5\/6\)\*\* \|/);
  assert.match(comment, /✅ \*\*Ready for maintainer review\*\*/);
  assert.doesNotMatch(comment, /\*\*PR rating\*\*/);
  assert.doesNotMatch(comment, /\*\*Real behavior proof\*\*/);
  assert.match(comment, /<summary><strong>Agent review details<\/strong><\/summary>/);
  assert.match(comment, /\| \*\*6\/6\*\* \| S \| 🦀 challenger crab \|/);
  assert.match(comment, /\| \*\*1\/6\*\* \| F \| 🧂 unranked krab \|/);
  assert.match(markers, /clawsweeper-verdict:pass/);
  assert.doesNotMatch(markers, /clawsweeper-verdict:needs-human/);
});

test("proof-blocked PR comments show proof cap while preserving patch quality", () => {
  const report = `${reportFrontMatter({
    type: "pull_request",
    number: "74460",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    author: "contributor",
    author_association: "CONTRIBUTOR",
    labels: JSON.stringify([]),
    work_candidate: "none",
    pull_head_sha: "abc123def456",
  })}

## Summary

Keep this PR open until proof is added.

## What This Changes

Filters noisy review-context comments before prompting.

## Best Possible Solution

Add real ClawSweeper ingestion proof before merge.

${realBehaviorProofReportSection({
  status: "missing",
  evidenceKind: "none",
  needsContributorAction: true,
  summary: "The PR has no real ingestion-run proof yet.",
})}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;

  const comment = renderReviewCommentFromReport(report, "none");
  const labelDetails = detailsBody(comment, "Label changes");

  assert.match(comment, /\| \*\*Overall readiness\*\* \| 🧂 unranked krab \*\*\(1\/6\)\*\* \|/);
  assert.match(comment, /\| \*\*Proof confidence\*\* \| 🧂 unranked krab \*\*\(1\/6\)\*\* \|/);
  assert.match(comment, /\| \*\*Patch quality\*\* \| 🦞 diamond lobster \*\*\(5\/6\)\*\* \|/);
  assert.match(comment, /⛔ \*\*Blocked until real behavior proof is added/);
  assert.match(comment, /- \[ \] \*\*Add real behavior proof\*\* - Needs real behavior proof/);
  assert.match(comment, /The PR has no real ingestion-run proof yet\./);
  assert.match(comment, /After adding proof, update the PR body/);
  assert.match(comment, /@clawsweeper re-review/);
  assert.match(
    labelDetails,
    /- `rating: 🧂 unranked krab`: Overall readiness is 🧂 unranked krab; proof is 🧂 unranked krab and patch quality is 🦞 diamond lobster\./,
  );
  assert.doesNotMatch(labelDetails, /PR readiness rating was derived from proof quality/);
});

test("failed Codex review comments suppress PR readiness ratings", () => {
  const report = `${reportFrontMatter({
    type: "pull_request",
    number: "91210",
    decision: "keep_open",
    close_reason: "none",
    review_status: "failed",
    confidence: "low",
    author: "contributor",
    author_association: "CONTRIBUTOR",
    labels: JSON.stringify(["proof: supplied", "rating: 🌊 off-meta tidepool"]),
    work_candidate: "none",
    pull_head_sha: "abc123def456",
    triage_priority: "none",
    impact_labels: JSON.stringify([]),
    merge_risk_labels: JSON.stringify([]),
    label_justifications: JSON.stringify([]),
    pr_rating_overall: "NA",
    pr_rating_proof: "NA",
    pr_rating_patch: "NA",
  })}

## Summary

Codex review failed: retryable codex transport failure (network).

## What This Changes

Review failed before ClawSweeper could summarize the requested change.

## Best Possible Solution

Retry the Codex review after fixing the execution failure.

${realBehaviorProofReportSection({
  status: "not_applicable",
  evidenceKind: "not_applicable",
  needsContributorAction: false,
  summary: "Real behavior proof was not assessed because the Codex review failed.",
})}

${prRatingReportSection({
  overallTier: "NA",
  proofTier: "NA",
  patchTier: "NA",
  overallLabel: "🌊 off-meta tidepool",
  proofLabel: "🌊 off-meta tidepool",
  patchLabel: "🌊 off-meta tidepool",
  summary: "PR readiness rating was not assessed because the Codex review failed.",
  nextSteps: "- none",
})}

## Evidence

- **failure reason:** retryable codex transport failure (network)
- **codex failure detail:** Codex review failed for this PR with exit 1.
`;

  const comment = renderReviewCommentFromReport(report, "none");
  const labelDetails = detailsBody(comment, "Label changes");

  assert.match(
    comment,
    /^ClawSweeper review: did not complete due to Codex infrastructure failure\./,
  );
  assert.match(comment, /## Merge readiness\n\nNot assessed\./);
  assert.match(
    comment,
    /This is a ClawSweeper\/Codex infrastructure failure, not a PR readiness or patch-quality verdict\./,
  );
  assert.doesNotMatch(comment, /Codex review: needs real behavior proof before merge\./);
  assert.doesNotMatch(comment, /Overall follows the weaker of proof and patch quality/);
  assert.doesNotMatch(comment, /### Rating scale/);
  assert.match(
    labelDetails,
    /- remove `rating: 🌊 off-meta tidepool`: Current review failed before PR readiness was assessed, so no rating label should remain\./,
  );
  assert.doesNotMatch(labelDetails, /Label justifications:[\s\S]*rating: 🌊 off-meta tidepool/);
});

test("public PR review comments explain label changes without duplicate justifications", () => {
  const report = `${reportFrontMatter({
    type: "pull_request",
    number: "74461",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    author: "contributor",
    author_association: "CONTRIBUTOR",
    labels: JSON.stringify([]),
    work_candidate: "none",
    triage_priority: "P1",
    impact_labels: JSON.stringify(["impact:message-loss"]),
    merge_risk_labels: JSON.stringify(["merge-risk: 🚨 compatibility"]),
    label_justifications: JSON.stringify([
      {
        label: "P1",
        reason: "The PR changes an active channel workflow affecting real users.",
      },
      {
        label: "impact:message-loss",
        reason: "The diff touches message retry and delivery ordering.",
      },
      {
        label: "merge-risk: 🚨 compatibility",
        reason: "Merging changes the default upgrade behavior for existing configs.",
      },
    ]),
  })}

## Summary

Keep this PR open for maintainer review.

## What This Changes

Changes message delivery behavior.

## Best Possible Solution

Review the compatibility impact before merge.

## Risks

Compatibility risk remains for existing configs.

${realBehaviorProofReportSection({
  status: "insufficient",
  needsContributorAction: true,
  summary: "The PR has tests but no real setup proof yet.",
})}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.8

Full review comments:

- none
`;

  const comment = renderReviewCommentFromReport(report, "none");

  assert.match(comment, /<summary><strong>Agent review details<\/strong><\/summary>/);
  assert.ok(comment.indexOf("### Labels") < comment.indexOf("### Rating scale"));
  assert.ok(comment.indexOf("### Rating scale") < comment.indexOf("### Workflow"));
  const labelDetails = detailsBody(comment, "Label changes");
  assert.match(labelDetails, /Label changes:/);
  assert.match(
    labelDetails,
    /- add `P1`: The PR changes an active channel workflow affecting real users\./,
  );
  assert.match(
    labelDetails,
    /- add `merge-risk: 🚨 compatibility`: Merging changes the default upgrade behavior for existing configs\./,
  );
  assert.match(labelDetails, /Label justifications:/);
  assert.match(
    labelDetails,
    /- `P1`: The PR changes an active channel workflow affecting real users\./,
  );
  assert.match(
    labelDetails,
    /- `impact:message-loss`: The diff touches message retry and delivery ordering\./,
  );
});

test("public PR review details justify derived rating label changes", () => {
  const report = `${reportFrontMatter({
    type: "pull_request",
    number: "84006",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    author: "contributor",
    author_association: "CONTRIBUTOR",
    labels: JSON.stringify(["rating: 🦞 diamond lobster"]),
    work_candidate: "none",
    triage_priority: "none",
    impact_labels: JSON.stringify([]),
    merge_risk_labels: JSON.stringify([]),
    label_justifications: JSON.stringify([]),
  })}

## Summary

Keep this PR open for maintainer review.

## What This Changes

Changes a PR under active review.

## Best Possible Solution

Add proof before merge.

${realBehaviorProofReportSection({
  status: "insufficient",
  needsContributorAction: true,
  summary: "The PR still needs current real-environment proof for the changed behavior.",
})}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;

  const comment = renderReviewCommentFromReport(report, "none");
  const labelDetails = detailsBody(comment, "Label changes");

  assert.match(labelDetails, /Label changes:/);
  assert.match(
    labelDetails,
    /- add `rating: 🦪 silver shellfish`: Overall readiness is 🦪 silver shellfish; proof is 🦪 silver shellfish and patch quality is 🦞 diamond lobster\. Replaced prior `rating: 🦞 diamond lobster`\./,
  );
  assert.match(
    labelDetails,
    /- remove `rating: 🦞 diamond lobster`: Current PR rating is `rating: 🦪 silver shellfish`, so this older rating label is no longer current\./,
  );
  assert.match(labelDetails, /Label justifications:/);
  assert.match(
    labelDetails,
    /- `rating: 🦪 silver shellfish`: Overall readiness is 🦪 silver shellfish; proof is 🦪 silver shellfish and patch quality is 🦞 diamond lobster\. Replaced prior `rating: 🦞 diamond lobster`\./,
  );
});

test("public PR review details justify stale owned label removals", () => {
  const report = `${reportFrontMatter({
    type: "pull_request",
    number: "84007",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    author: "contributor",
    author_association: "CONTRIBUTOR",
    labels: JSON.stringify(["status: 📣 needs proof"]),
    work_candidate: "none",
    triage_priority: "none",
    impact_labels: JSON.stringify([]),
    merge_risk_labels: JSON.stringify([]),
    label_justifications: JSON.stringify([]),
  })}

## Summary

Keep this PR open for maintainer review.

## What This Changes

Updates an already-reviewed PR.

## Best Possible Solution

Add current real behavior proof before merge.

${realBehaviorProofReportSection({
  status: "insufficient",
  evidenceKind: "none",
  needsContributorAction: true,
  summary: "The current review has no usable real behavior proof.",
})}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;

  const comment = renderReviewCommentFromReport(report, "none", {
    prStatusKind: "needs_proof",
    previousLabels: [
      "P1",
      "impact:message-loss",
      "merge-risk: 🚨 compatibility",
      "proof: sufficient",
      "proof: 🎥 video",
      "mantis: telegram-visible-proof",
      "status: 📣 needs proof",
    ],
  });

  assert.match(comment, /Label changes:/);
  assert.match(comment, /- remove `P1`: Current review triage priority is none\./);
  assert.match(
    comment,
    /- remove `impact:message-loss`: Current review selected no impact labels\./,
  );
  assert.match(
    comment,
    /- remove `merge-risk: 🚨 compatibility`: Current PR review selected no merge-risk labels\./,
  );
  assert.match(
    comment,
    /- remove `proof: sufficient`: Current real behavior proof status is insufficient, not sufficient\./,
  );
  assert.match(
    comment,
    /- remove `proof: 🎥 video`: Current real behavior proof evidence kind is none\./,
  );
  assert.match(
    comment,
    /- remove `mantis: telegram-visible-proof`: Current Telegram visible-proof status is not_needed\./,
  );
  assert.doesNotMatch(comment, /remove `status: 📣 needs proof`/);
});

test("public PR review details justify derived rating label changes", () => {
  const report = `${reportFrontMatter({
    type: "pull_request",
    number: "84006",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    author: "contributor",
    author_association: "CONTRIBUTOR",
    labels: JSON.stringify(["rating: 🦞 diamond lobster"]),
    work_candidate: "none",
    triage_priority: "none",
    impact_labels: JSON.stringify([]),
    merge_risk_labels: JSON.stringify([]),
    label_justifications: JSON.stringify([]),
  })}

## Summary

Keep this PR open for maintainer review.

## What This Changes

Changes a PR under active review.

## Best Possible Solution

Add proof before merge.

${realBehaviorProofReportSection({
  status: "insufficient",
  needsContributorAction: true,
  summary: "The PR still needs current real-environment proof for the changed behavior.",
})}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;

  const comment = renderReviewCommentFromReport(report, "none");
  const labelDetails = detailsBody(comment, "Label changes");

  assert.match(labelDetails, /Label changes:/);
  assert.match(
    labelDetails,
    /- add `rating: 🦪 silver shellfish`: Overall readiness is 🦪 silver shellfish; proof is 🦪 silver shellfish and patch quality is 🦞 diamond lobster\. Replaced prior `rating: 🦞 diamond lobster`\./,
  );
  assert.match(
    labelDetails,
    /- remove `rating: 🦞 diamond lobster`: Current PR rating is `rating: 🦪 silver shellfish`, so this older rating label is no longer current\./,
  );
  assert.match(labelDetails, /Label justifications:/);
  assert.match(
    labelDetails,
    /- `rating: 🦪 silver shellfish`: Overall readiness is 🦪 silver shellfish; proof is 🦪 silver shellfish and patch quality is 🦞 diamond lobster\. Replaced prior `rating: 🦞 diamond lobster`\./,
  );
});

test("public PR review details justify stale owned label removals", () => {
  const report = `${reportFrontMatter({
    type: "pull_request",
    number: "84007",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    confidence: "high",
    author: "contributor",
    author_association: "CONTRIBUTOR",
    labels: JSON.stringify(["status: 📣 needs proof"]),
    work_candidate: "none",
    triage_priority: "none",
    impact_labels: JSON.stringify([]),
    merge_risk_labels: JSON.stringify([]),
    label_justifications: JSON.stringify([]),
  })}

## Summary

Keep this PR open for maintainer review.

## What This Changes

Updates an already-reviewed PR.

## Best Possible Solution

Add current real behavior proof before merge.

${realBehaviorProofReportSection({
  status: "insufficient",
  evidenceKind: "none",
  needsContributorAction: true,
  summary: "The current review has no usable real behavior proof.",
})}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;

  const comment = renderReviewCommentFromReport(report, "none", {
    prStatusKind: "needs_proof",
    previousLabels: [
      "P1",
      "impact:message-loss",
      "merge-risk: 🚨 compatibility",
      "proof: sufficient",
      "proof: 🎥 video",
      "mantis: telegram-visible-proof",
      "status: 📣 needs proof",
    ],
  });

  assert.match(comment, /Label changes:/);
  assert.match(comment, /- remove `P1`: Current review triage priority is none\./);
  assert.match(
    comment,
    /- remove `impact:message-loss`: Current review selected no impact labels\./,
  );
  assert.match(
    comment,
    /- remove `merge-risk: 🚨 compatibility`: Current PR review selected no merge-risk labels\./,
  );
  assert.match(
    comment,
    /- remove `proof: sufficient`: Current real behavior proof status is insufficient, not sufficient\./,
  );
  assert.match(
    comment,
    /- remove `proof: 🎥 video`: Current real behavior proof evidence kind is none\./,
  );
  assert.match(
    comment,
    /- remove `mantis: telegram-visible-proof`: Current Telegram visible-proof status is not_needed\./,
  );
  assert.doesNotMatch(comment, /remove `status: 📣 needs proof`/);
});
