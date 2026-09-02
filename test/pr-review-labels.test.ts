import assert from "node:assert/strict";
import test from "node:test";

import {
  renderReviewCommentFromReport,
  reviewAutomationMarkersFromReport,
} from "../dist/clawsweeper.js";
import { LIVE_VERIFICATION_MARKER } from "../dist/clawsweeper-policy.js";
import type { LiveProofPlan } from "../dist/clawsweeper-types.js";
import {
  encodeLiveVerificationReportPayload,
  liveProofPlanSha256,
} from "../dist/live-proof/verification.js";
import {
  detailsBody,
  prRatingReportSection,
  realBehaviorProofReportSection,
  reviewReportFrontMatter as reportFrontMatter,
} from "./helpers.ts";

const REVIEW_HEAD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

for (const proofStatus of ["missing", "not_applicable"] as const) {
  test(`failed ${proofStatus} reports do not retain positive public status labels`, () => {
    const oldStatuses = ["status: 🚀 automerge armed", "status: 👀 ready for maintainer look"];
    for (const malformedReceipt of [false, true]) {
      for (const extraLabels of [
        [],
        ["clawsweeper:automerge"],
        ["status: 🔁 re-review loop"],
        ["status: 🛠️ actively grinding"],
        ["clawsweeper:human-review"],
      ]) {
        const report = `${reportFrontMatter({
          type: "pull_request",
          number: "74466",
          review_status: "failed",
          author: "contributor",
          author_association: "CONTRIBUTOR",
          labels: JSON.stringify([...oldStatuses, ...extraLabels]),
        })}
${realBehaviorProofReportSection({
  status: proofStatus,
  evidenceKind: proofStatus === "missing" ? "none" : "not_applicable",
  needsContributorAction: proofStatus === "missing",
  summary: "Retained proof assessment from an incomplete review.",
})}
## Review Findings

Overall correctness: patch is correct

Full review comments:

- none

${malformedReceipt ? `## Live Proof\n\n${LIVE_VERIFICATION_MARKER}\nResult: invalid!` : ""}
`;
        const comment = renderReviewCommentFromReport(report, "none");
        assert.match(comment, /## Merge readiness\n\nNot assessed\./);
        assert.doesNotMatch(
          comment,
          /\*\*Add real behavior proof\*\*|add `status: 📣 needs proof`/,
        );
        const details = detailsBody(comment, "Label changes");
        for (const oldStatus of oldStatuses) {
          assert.ok(details.includes(`remove \`${oldStatus}\``), oldStatus);
          assert.ok(!details.includes(`add \`${oldStatus}\``), oldStatus);
        }
        const workflowStatus = extraLabels.find((label) => label.startsWith("status:"));
        if (workflowStatus) assert.ok(!details.includes(`remove \`${workflowStatus}\``));
        assert.equal(
          details.includes("add `status: needs maintainer proof decision`"),
          malformedReceipt && !workflowStatus && !extraLabels.includes("clawsweeper:human-review"),
        );
        const markers = reviewAutomationMarkersFromReport(report);
        assert.match(
          markers,
          new RegExp(`live_verification=${malformedReceipt ? "malformed" : "absent"}`),
        );
        assert.match(markers, /clawsweeper-verdict:needs-human/);
        assert.doesNotMatch(markers, /clawsweeper-verdict:pass|clawsweeper-action:fix-required/);
        assert.ok(comment.includes(markers));
      }
    }
  });
}

test("report proof requirements preserve workflow precedence and contributor ownership", () => {
  for (const fixture of [
    {
      status: "not_applicable",
      action: false,
      labels: ["clawsweeper:automerge"],
      expected: "status: 📣 needs proof",
    },
    {
      status: "not_applicable",
      action: false,
      labels: ["status: 📣 needs proof"],
      expected: "status: 📣 needs proof",
    },
    {
      status: "not_applicable",
      action: false,
      labels: ["status: 🔁 re-review loop"],
      expected: "status: 🔁 re-review loop",
    },
    {
      status: "not_applicable",
      action: false,
      labels: ["status: 🛠️ actively grinding"],
      expected: "status: 🛠️ actively grinding",
    },
    {
      status: "not_applicable",
      action: false,
      labels: ["clawsweeper:human-review"],
      expected: null,
    },
    {
      status: "not_applicable",
      action: false,
      labels: ["clawsweeper:manual-only"],
      expected: null,
    },
    {
      status: "not_applicable",
      action: false,
      labels: ["clawsweeper:merge-ready"],
      expected: null,
    },
    {
      status: "missing",
      action: false,
      labels: [],
      expected: "status: needs maintainer proof decision",
    },
    {
      status: "mock_only",
      action: false,
      labels: [],
      expected: "status: needs maintainer proof decision",
    },
    {
      status: "insufficient",
      action: false,
      labels: [],
      expected: "status: needs maintainer proof decision",
    },
  ]) {
    const report = `${reportFrontMatter({
      type: "pull_request",
      review_status: "complete",
      author_association: "CONTRIBUTOR",
      author: "contributor",
      labels: JSON.stringify(fixture.labels),
      pull_files: '["src/runtime.ts"]',
      pull_files_truncated: false,
    })}
${realBehaviorProofReportSection({
  status: fixture.status,
  evidenceKind: fixture.status === "not_applicable" ? "not_applicable" : "none",
  needsContributorAction: fixture.action,
  summary: "Recorded assessment for the changed path.",
})}`;
    const comment = renderReviewCommentFromReport(report, "none");
    const labels = detailsBody(comment, "Label changes");
    assert.deepEqual(
      [...labels.matchAll(/^- `(status: [^`]+)`: /gm)].map((match) => match[1]),
      fixture.expected ? [fixture.expected] : [],
      JSON.stringify(fixture),
    );
    assert.match(reviewAutomationMarkersFromReport(report), /clawsweeper-verdict:needs-human/);
    assert.match(comment, /⛔ \*\*Blocked before merge/);
    if (fixture.status !== "not_applicable") {
      assert.doesNotMatch(comment, /\*\*Add real behavior proof\*\*/);
      assert.match(comment, /\*\*Resolve real behavior proof assessment\*\*/);
    }
  }
});
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
    pull_head_sha: REVIEW_HEAD_SHA,
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
    pull_head_sha: REVIEW_HEAD_SHA,
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
  assert.match(comment, /⛔ \*\*Blocked before merge - 2 items remain\*\*/);
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

test("active repair-loop statuses outrank proof fallback without preserving stale automerge", () => {
  const cases = [
    {
      labels: ["clawsweeper:automerge", "status: 🔁 re-review loop"],
      expected: "status: 🔁 re-review loop",
    },
    {
      labels: ["clawsweeper:automerge", "status: 🛠️ actively grinding"],
      expected: "status: 🛠️ actively grinding",
    },
    {
      labels: ["clawsweeper:automerge"],
      expected: "status: 📣 needs proof",
    },
  ];

  for (const [index, fixture] of cases.entries()) {
    const report = `${reportFrontMatter({
      type: "pull_request",
      number: String(74500 + index),
      decision: "keep_open",
      close_reason: "none",
      review_status: "complete",
      confidence: "high",
      author: "contributor",
      author_association: "CONTRIBUTOR",
      labels: JSON.stringify(fixture.labels),
      work_candidate: "none",
      pull_head_sha: "abc123def456",
    })}

## Summary

Keep this PR in its current repair-loop state.

## What This Changes

Updates the reviewed implementation.

## Best Possible Solution

Complete the active review workflow before merge.

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
      previousLabels: ["status: 🚀 automerge armed"],
    });
    const labelDetails = detailsBody(comment, "Label changes");

    assert.match(labelDetails, new RegExp(`add \`${fixture.expected}\``));
    assert.match(labelDetails, /remove `status: 🚀 automerge armed`/);
  }
});

test("recorded proof reconciles public proof statuses independently of historical receipts", () => {
  const headSha = "a".repeat(40);
  const plan: LiveProofPlan = {
    status: "recommended",
    surface: "terminal",
    terminalCompletion: "exit_zero",
    reason: "The changed CLI output is visible.",
    payoff: {
      kind: "progressive_output",
      justification: "The viewer sees the clean help output.",
    },
    entry: "node scripts/run-node.mjs --help",
    steps: [{ action: "expect_output", text: "Usage: openclaw" }],
  };
  const attachedVerification = `${LIVE_VERIFICATION_MARKER}
Result: ${encodeLiveVerificationReportPayload({
    schema_version: 1,
    repo: "openclaw/openclaw",
    item: 74510,
    head_sha: headSha,
    plan_sha256: liveProofPlanSha256(plan),
    surface: "terminal",
    entry: "node scripts/run-node.mjs --help",
    drive_status: "completed",
    steps: [
      {
        action: "expect_output",
        status: "completed",
        detail: "clean help output was observed",
        assertion: "Usage: openclaw",
        present_at_start: false,
        satisfied: true,
      },
    ],
    output: "Usage: openclaw",
    overall_pass: true,
    verified_at: "2026-08-27T12:00:00.000Z",
  })}`;
  const cases = [
    {
      labels: ["clawsweeper:automerge", "status: 📣 needs proof"],
      stale: "status: 📣 needs proof",
      expected: "status: 📣 needs proof",
      resolvedExpected: "status: 🚀 automerge armed",
    },
    {
      labels: ["status: needs maintainer proof decision", "status: 👀 ready for maintainer look"],
      stale: "status: needs maintainer proof decision",
      expected: "status: 📣 needs proof",
      resolvedExpected: "status: 👀 ready for maintainer look",
    },
    {
      labels: ["status: 📣 needs proof"],
      stale: "status: 📣 needs proof",
      expected: "status: 📣 needs proof",
      resolvedExpected: null,
    },
    {
      labels: ["status: needs maintainer proof decision"],
      stale: "status: needs maintainer proof decision",
      expected: "status: 📣 needs proof",
      resolvedExpected: null,
    },
    {
      labels: ["status: 🚀 automerge armed", "status: 📣 needs proof", "status: 🔁 re-review loop"],
      stale: "status: 📣 needs proof",
      expected: "status: 🔁 re-review loop",
    },
    {
      labels: [
        "status: 🚀 automerge armed",
        "status: 📣 needs proof",
        "status: 🛠️ actively grinding",
      ],
      stale: "status: 📣 needs proof",
      expected: "status: 🛠️ actively grinding",
    },
  ];

  for (const fixture of cases) {
    for (const sufficient of [false, true]) {
      const report = `${reportFrontMatter({
        type: "pull_request",
        number: "74510",
        decision: "keep_open",
        close_reason: "none",
        review_status: "complete",
        confidence: "high",
        author: "contributor",
        author_association: "CONTRIBUTOR",
        labels: JSON.stringify(fixture.labels),
        work_candidate: "none",
        pull_head_sha: headSha,
      })}

## Summary

Keep this PR open for its current review status.

## What This Changes

Updates the reviewed implementation.

## Best Possible Solution

Honor the attached verification result and current non-proof status.

${realBehaviorProofReportSection({
  status: sufficient ? "sufficient" : "missing",
  evidenceKind: sufficient ? "recording" : "none",
  needsContributorAction: !sufficient,
  summary: sufficient
    ? "Reviewer-assessed recording exercises the changed authorization boundary."
    : "The model did not record real behavior proof.",
})}

## Live Proof

Status: recommended

Surface: terminal

Terminal completion: exit_zero

Reason: The changed CLI output is visible.

Payoff: progressive_output

Payoff justification: The viewer sees the clean help output.

Entry: node scripts/run-node.mjs --help

Steps:

- {"action":"expect_output","text":"Usage: openclaw"}

${attachedVerification}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;

      const expected =
        sufficient && fixture.resolvedExpected !== undefined
          ? fixture.resolvedExpected
          : fixture.expected;
      for (const attached of [true, false]) {
        const currentReport = attached ? report : report.replace(attachedVerification, "");
        const comment = renderReviewCommentFromReport(currentReport, "none", {
          previousLabels: [fixture.stale],
        });
        const labelDetails = detailsBody(comment, "Label changes");
        // Existing stale labels can be justified without an add line; inspect the selected status.
        const justifiedStatuses = [...labelDetails.matchAll(/^- `(status: [^`]+)`: /gm)].map(
          (match) => match[1],
        );
        const context = `${fixture.stale}: sufficient=${sufficient}, attached=${attached}`;
        assert.deepEqual(justifiedStatuses, expected ? [expected] : [], context);
        if (expected !== fixture.stale) {
          assert.ok(labelDetails.includes(`remove \`${fixture.stale}\``), context);
        }
        assert.equal(/add `proof: sufficient`/.test(labelDetails), sufficient, context);
        if (!sufficient) {
          assert.doesNotMatch(
            reviewAutomationMarkersFromReport(currentReport),
            /clawsweeper-verdict:pass/,
            context,
          );
        }
      }
    }
  }
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
    pull_head_sha: REVIEW_HEAD_SHA,
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
      "proof: telegram-e2e",
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
    /- remove `proof: telegram-e2e`: Current Telegram visible-proof status is not_needed\./,
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
      "proof: telegram-e2e",
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
    /- remove `proof: telegram-e2e`: Current Telegram visible-proof status is not_needed\./,
  );
  assert.doesNotMatch(comment, /remove `status: 📣 needs proof`/);
});
