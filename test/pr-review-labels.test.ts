import { renderReviewCommentFromReport } from "../dist/clawsweeper-report-comment-presentation.js";
import assert from "node:assert/strict";
import test from "node:test";

import { reviewAutomationMarkersFromReport } from "../dist/clawsweeper.js";
const LIVE_VERIFICATION_MARKER = "<!-- clawsweeper-live-verification -->";
import {
  detailsBody,
  prRatingReportSection,
  realBehaviorProofReportSection,
  reviewReportFrontMatter,
  withReviewRecord,
} from "./helpers.ts";

const REVIEW_HEAD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const sufficientProof = {
  status: "sufficient",
  evidenceKind: "terminal",
  needsContributorAction: false,
  summary:
    "The PR includes a terminal transcript from a real OpenClaw setup showing the fixed behavior after the patch.",
};
const normalRating = {
  overallTier: "B",
  proofTier: "A",
  patchTier: "B",
  summary: "This PR has strong proof and normal merge-ready implementation quality.",
  nextSteps: [],
};

function reportFrontMatter(
  fields: Record<string, unknown>,
  decision: Record<string, unknown> = {},
) {
  return withReviewRecord(reviewReportFrontMatter({ number: "180", ...fields }), {
    decision: "keep_open",
    closeReason: "none",
    overallCorrectness: "patch is correct",
    nextStep: { kind: "none", text: "" },
    workCandidate: fields.work_candidate ?? "none",
    triagePriority: fields.triage_priority ?? "none",
    impactLabels: JSON.parse(String(fields.impact_labels ?? "[]")),
    mergeRiskLabels: JSON.parse(String(fields.merge_risk_labels ?? "[]")),
    labelJustifications: JSON.parse(String(fields.label_justifications ?? "[]")),
    realBehaviorProof: sufficientProof,
    prRating: normalRating,
    ...decision,
  });
}

test("explicit no-op label plans require publisher confirmation and a completed owned plan", () => {
  const desiredLabels = [
    "P2",
    "proof: sufficient",
    "rating: 🐚 platinum hermit",
    "status: 👀 ready for maintainer look",
  ];
  const report = (overrides = {}, decision = {}) => `${reportFrontMatter(
    {
      type: "pull_request",
      number: "180",
      review_status: "complete",
      author: "contributor",
      author_association: "CONTRIBUTOR",
      pull_head_sha: REVIEW_HEAD_SHA,
      triage_priority: "P2",
      labels: JSON.stringify(desiredLabels),
      label_justifications: JSON.stringify([
        { label: "P2", reason: "A bounded presentation fix." },
      ]),
      ...overrides,
    },
    decision,
  )}
${realBehaviorProofReportSection()}
${prRatingReportSection()}
## Review Findings

Overall correctness: patch is correct

Full review comments:

- none
`;
  for (const fixture of [
    { name: "equal", markdown: report(), previousLabels: desiredLabels, noOp: true },
    { name: "different", markdown: report(), previousLabels: ["P1"], noOp: false },
    { name: "metadata only", markdown: report(), previousLabels: undefined, noOp: false },
    {
      name: "failed with retained justification",
      markdown: report({ review_status: "failed", labels: '["P2"]' }),
      previousLabels: ["P2"],
      publishedLabels: ["P2"],
      noOp: false,
    },
    {
      name: "unowned issue labels",
      markdown: report({
        type: "issue",
        triage_priority: "none",
        label_justifications: "[]",
        labels: '["bug"]',
      }),
      previousLabels: ["bug"],
      publishedLabels: ["bug"],
      noOp: false,
    },
    {
      name: "unowned justification",
      markdown: report(
        {
          type: "issue",
          triage_priority: "none",
          label_justifications: JSON.stringify([{ label: "bug", reason: "Unowned label." }]),
          labels: '["bug"]',
        },
        {
          // Unowned frontmatter remains inert; it is not a valid model label selection.
          labelJustifications: [],
        },
      ),
      previousLabels: ["bug"],
      publishedLabels: ["bug"],
      noOp: false,
    },
  ]) {
    const comment = renderReviewCommentFromReport(fixture.markdown, "none", {
      previousLabels: fixture.previousLabels,
      publishedLabels: fixture.publishedLabels,
      prStatusKind: "ready_for_maintainer_look",
    });
    const labels = fixture.name.startsWith("unowned") ? "" : detailsBody(comment, "Label changes");
    if (fixture.name.startsWith("unowned")) {
      assert.doesNotMatch(comment, /Label changes:|Label justifications:|No label changes\./);
    }
    assert.equal(labels.includes("No label changes."), fixture.noOp, fixture.name);
    if (fixture.name === "different") {
      assert.match(labels, /- add `P2`:/);
      assert.match(labels, /- remove `P1`:/);
    } else {
      assert.doesNotMatch(labels, /- (add|remove) `/, fixture.name);
    }
    if (fixture.name === "failed with retained justification") {
      assert.match(labels, /`P2`: A bounded presentation fix\./);
    }
    assert.ok(comment.includes(reviewAutomationMarkersFromReport(fixture.markdown)), fixture.name);
  }
});

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
        const report = `${reportFrontMatter(
          {
            type: "pull_request",
            number: "74466",
            review_status: "failed",
            author: "contributor",
            author_association: "CONTRIBUTOR",
            labels: JSON.stringify([...oldStatuses, ...extraLabels]),
          },
          {
            realBehaviorProof: {
              status: proofStatus,
              evidenceKind: proofStatus === "missing" ? "none" : "not_applicable",
              needsContributorAction: proofStatus === "missing",
              summary: "Retained proof assessment from an incomplete review.",
            },
          },
        )}
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
        assert.equal(details.includes("add `status: needs maintainer proof decision`"), false);
        const markers = reviewAutomationMarkersFromReport(report);
        assert.doesNotMatch(markers, /live_verification=/);
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
      status: "missing",
      action: true,
      labels: ["clawsweeper:automerge"],
      expected: "status: 📣 needs proof",
    },
    {
      status: "missing",
      action: true,
      labels: ["status: 📣 needs proof"],
      expected: "status: 📣 needs proof",
    },
    {
      status: "missing",
      action: true,
      labels: ["status: 🔁 re-review loop"],
      expected: "status: 🔁 re-review loop",
    },
    {
      status: "missing",
      action: true,
      labels: ["status: 🛠️ actively grinding"],
      expected: "status: 🛠️ actively grinding",
    },
    {
      status: "missing",
      action: true,
      labels: ["clawsweeper:human-review"],
      expected: null,
    },
    {
      status: "missing",
      action: true,
      labels: ["clawsweeper:manual-only"],
      expected: null,
    },
    {
      status: "missing",
      action: true,
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
    const report = `${reportFrontMatter(
      {
        type: "pull_request",
        review_status: "complete",
        author_association: "CONTRIBUTOR",
        author: "contributor",
        labels: JSON.stringify(fixture.labels),
        pull_files: '["src/runtime.ts"]',
        pull_files_truncated: false,
      },
      {
        realBehaviorProof: {
          status: fixture.status,
          evidenceKind: "none",
          needsContributorAction: fixture.action,
          summary: "Recorded assessment for the changed path.",
        },
      },
    )}
${realBehaviorProofReportSection({
  status: fixture.status,
  evidenceKind: "none",
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
    if (!fixture.action) {
      assert.doesNotMatch(comment, /\*\*Add real behavior proof\*\*/);
      assert.match(comment, /\*\*Resolve real behavior proof assessment\*\*/);
    }
  }
});
test("sufficient real behavior proof allows automerge pass markers", () => {
  const report = `${reportFrontMatter(
    {
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
    },
    {
      summary: "Keep this focused PR open for automerge.",
      changeSummary: "Fixes the gateway status output.",
      bestSolution: "Merge after required checks are green.",
      prRating: { ...normalRating, overallTier: "A", patchTier: "A" },
    },
  )}

## Summary

Keep this focused PR open for automerge.

## What This Changes

Fixes the gateway status output.

## Best Possible Solution

Merge after required checks are green.

${realBehaviorProofReportSection()}

${prRatingReportSection({ overallTier: "A", proofTier: "A", patchTier: "A" })}

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
  assert.match(comment, /### Rating scale\n\n6\/6 🦀 challenger crab · 5\/6 🦞 diamond lobster ·/);
  assert.match(comment, /· 1\/6 🧂 unranked krab\. Overall follows the weaker of proof/);
  assert.match(markers, /clawsweeper-verdict:pass/);
  assert.doesNotMatch(markers, /clawsweeper-verdict:needs-human/);
});

test("proof-blocked PR comments show the model rating while preserving patch quality", () => {
  const report = `${reportFrontMatter(
    {
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
    },
    {
      realBehaviorProof: {
        status: "missing",
        evidenceKind: "none",
        needsContributorAction: true,
        summary: "The PR has no real ingestion-run proof yet.",
      },
      prRating: { ...normalRating, overallTier: "F", proofTier: "F", patchTier: "A" },
    },
  )}

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

${prRatingReportSection({ overallTier: "F", proofTier: "F", patchTier: "A", nextSteps: "- none" })}

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
  assert.match(comment, /⛔ \*\*Blocked before merge - 1 item remains\*\*/);
  assert.match(
    comment,
    /- \[ \] \*\*Add real behavior proof\*\* - The PR has no real ingestion-run proof yet\./,
  );
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
    const report = `${reportFrontMatter(
      {
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
      },
      {
        realBehaviorProof: {
          status: "insufficient",
          evidenceKind: "none",
          needsContributorAction: true,
          summary: "The current review has no usable real behavior proof.",
        },
      },
    )}

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
  const attachedVerification = "<!-- clawsweeper-live-verification -->\nResult: invalid!";
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
      resolvedExpected: "status: 👀 ready for maintainer look",
    },
    {
      labels: ["status: needs maintainer proof decision"],
      stale: "status: needs maintainer proof decision",
      expected: "status: 📣 needs proof",
      resolvedExpected: "status: 👀 ready for maintainer look",
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
      const report = `${reportFrontMatter(
        {
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
        },
        {
          realBehaviorProof: {
            status: sufficient ? "sufficient" : "missing",
            evidenceKind: sufficient ? "recording" : "none",
            needsContributorAction: !sufficient,
            summary: sufficient
              ? "Reviewer-assessed recording exercises the changed authorization boundary."
              : "The model did not record real behavior proof.",
          },
        },
      )}

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
  const report = `${reportFrontMatter(
    {
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
    },
    {
      summary: "Codex review failed: retryable codex transport failure (network).",
      changeSummary: "Review failed before ClawSweeper could summarize the requested change.",
      bestSolution: "Retry the Codex review after fixing the execution failure.",
      realBehaviorProof: {
        status: "not_applicable",
        evidenceKind: "not_applicable",
        needsContributorAction: false,
        summary: "Real behavior proof was not assessed because the Codex review failed.",
      },
      prRating: {
        overallTier: "NA",
        proofTier: "NA",
        patchTier: "NA",
        nextSteps: [],
        summary: "PR readiness rating was not assessed because the Codex review failed.",
      },
    },
  )}

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
  const report = `${reportFrontMatter(
    {
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
    },
    {
      risks: ["Compatibility risk remains for existing configs."],
      realBehaviorProof: {
        ...sufficientProof,
        status: "insufficient",
        needsContributorAction: true,
        summary: "The PR has tests but no real setup proof yet.",
      },
    },
  )}

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

test("public PR review details justify model rating label changes", () => {
  const report = `${reportFrontMatter(
    {
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
    },
    {
      realBehaviorProof: {
        ...sufficientProof,
        status: "insufficient",
        needsContributorAction: true,
        summary: "The PR still needs current real-environment proof for the changed behavior.",
      },
      prRating: { ...normalRating, overallTier: "D", proofTier: "D", patchTier: "A" },
    },
  )}

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

${prRatingReportSection({ overallTier: "D", proofTier: "D", patchTier: "A", nextSteps: "- none" })}

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
  const report = `${reportFrontMatter(
    {
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
    },
    {
      realBehaviorProof: {
        status: "insufficient",
        evidenceKind: "none",
        needsContributorAction: true,
        summary: "The current review has no usable real behavior proof.",
      },
    },
  )}

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
