import assert from "node:assert/strict";
import test from "node:test";

import {
  renderReviewCommentFromReport,
  reviewAutomationMarkersFromReport,
} from "../dist/clawsweeper.js";
import { detailsBody, reportFrontMatter } from "./helpers.ts";

test("security-needs-attention reports block unopted repair and automerge pass markers", () => {
  const securitySection = `
## Security Review

Status: needs_attention

Summary: The patch exposes a broader token scope and needs maintainer security review.

Concerns:

- **[high] Avoid broad token reuse:** \`src/auth/token.ts:42\`
  - body: The patch can reuse a token with broader scopes than the caller requested.
  - confidence: 0.91
`;
  const repairMarkers = reviewAutomationMarkersFromReport(`${reportFrontMatter({
    type: "pull_request",
    number: "74123",
    pull_head_sha: "abc123def456",
    decision: "keep_open",
    confidence: "high",
    work_candidate: "queue_fix_pr",
  })}

## Summary

Needs a repair.

${securitySection}
`);

  assert.match(repairMarkers, /clawsweeper-security:security-sensitive/);
  assert.match(repairMarkers, /clawsweeper-verdict:needs-human/);
  assert.doesNotMatch(repairMarkers, /clawsweeper-verdict:needs-changes/);
  assert.doesNotMatch(repairMarkers, /clawsweeper-action:fix-required/);

  const autofixRepairMarkers = reviewAutomationMarkersFromReport(`${reportFrontMatter({
    type: "pull_request",
    number: "74125",
    pull_head_sha: "abc789def123",
    decision: "keep_open",
    confidence: "high",
    labels: JSON.stringify(["clawsweeper:autofix"]),
    work_candidate: "queue_fix_pr",
  })}

## Summary

Needs an opted-in repair.

${securitySection}
`);

  assert.match(autofixRepairMarkers, /clawsweeper-security:security-sensitive/);
  assert.match(autofixRepairMarkers, /clawsweeper-verdict:needs-changes/);
  assert.match(autofixRepairMarkers, /clawsweeper-action:fix-required/);
  assert.match(autofixRepairMarkers, /finding=security-review/);
  assert.doesNotMatch(autofixRepairMarkers, /clawsweeper-verdict:needs-human/);
  assert.doesNotMatch(autofixRepairMarkers, /clawsweeper-verdict:pass/);

  const automergeMarkers = reviewAutomationMarkersFromReport(`${reportFrontMatter({
    type: "pull_request",
    number: "74124",
    pull_head_sha: "def456abc123",
    decision: "keep_open",
    confidence: "high",
    review_status: "complete",
    labels: JSON.stringify(["clawsweeper:automerge"]),
    work_candidate: "none",
  })}

## Summary

Would otherwise pass automerge.

${securitySection}
`);

  assert.match(automergeMarkers, /clawsweeper-security:security-sensitive/);
  assert.match(automergeMarkers, /clawsweeper-verdict:needs-changes/);
  assert.match(automergeMarkers, /clawsweeper-action:fix-required/);
  assert.match(automergeMarkers, /finding=security-review/);
  assert.doesNotMatch(automergeMarkers, /clawsweeper-verdict:pass/);
  assert.doesNotMatch(automergeMarkers, /clawsweeper-verdict:needs-human/);
});

test("pull request keep-open review comments suppress duplicate remaining risk text", () => {
  const duplicateRisk = "Run the automerge smoke after the repair lane is green.";
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "pull_request",
      number: "74267",
      decision: "keep_open",
      close_reason: "none",
      work_candidate: "none",
      pull_head_sha: "abc123def456",
    })}

## Summary

Keep this smoke-test PR open for maintainer review.

## What This Changes

Adds regression coverage for automerge repair smoke comments.

## Risks / Open Questions

${duplicateRisk}

## Work Candidate

Candidate: none

Confidence: low

Priority: low

Status: none

Reason: ${duplicateRisk}
`,
    "none",
  );

  assert.ok(comment.includes(`**Next step before merge**\n- [P2] ${duplicateRisk}`));
  assert.doesNotMatch(comment, /Remaining risk \/ open question:/);
  assert.doesNotMatch(comment, /\*\*Risk before merge\*\*/);
  assert.equal(comment.split(duplicateRisk).length - 1, 1);
});

test("pull request keep-open review comments prefix each merge risk bullet", () => {
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "pull_request",
      number: "74269",
      decision: "keep_open",
      close_reason: "none",
      work_candidate: "none",
      pull_head_sha: "abc123def456",
    })}

## Summary

Keep this multi-risk PR open for maintainer review.

## What This Changes

Changes generated review-comment formatting.

## Best Possible Solution

Confirm both merge risks before merge.

## Risks / Open Questions

- Blocked workflow actions must render as P1.
- Timeout fallback wording should remain scannable.
`,
    "none",
  );

  assert.match(comment, /\*\*Risk before merge\*\*/);
  assert.match(comment, /- \[P1\] Blocked workflow actions must render as P1\./);
  assert.match(comment, /- \[P2\] Timeout fallback wording should remain scannable\./);
  assert.doesNotMatch(comment, /- \[P1\] Blocked workflow actions.*\n- Timeout fallback/s);
});

test("pull request risk text does not priority-prefix routine CI noise", () => {
  const routineCiRisk = "CI checks are red on this branch and may be unrelated to the diff.";
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "pull_request",
      number: "74269",
      decision: "keep_open",
      close_reason: "none",
      work_candidate: "none",
      pull_head_sha: "abc123def456",
    })}

## Summary

Keep this PR open while maintainers verify check state.

## What This Changes

Updates review guidance.

## Best Possible Solution

Merge after the unrelated CI state is understood.

## Risks / Open Questions

${routineCiRisk}
`,
    "none",
  );

  assert.match(comment, /\*\*Risk before merge\*\*/);
  assert.match(comment, new RegExp(`- ${routineCiRisk.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.doesNotMatch(
    comment,
    new RegExp(`\\[P[12]\\] ${routineCiRisk.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
});

test("pull request next step does not priority-prefix routine required status checks", () => {
  const routineStatusSteps = [
    "Merge after required status checks are green.",
    "Merge after required checks pass.",
    "Merge after status checks pass.",
    "Merge once required checks have passed.",
    "Wait for status checks to pass.",
    "Merge after required checks.",
    "Wait for required checks.",
    "Merge after required checks pass and no failures are seen.",
    "Merge after required checks pass without failures.",
    "Merge after required checks pass without any failures.",
    "CI checks pass without test failures.",
    "Merge after required checks pass without any test failures.",
    "CI checks pass but no failures are seen.",
    "CI checks pass but maintainer review is still required.",
    "Required checks pass and required approvals are complete.",
    "CI checks are red but may pass on rerun.",
    "Merge after required checks and maintainer review.",
  ];
  for (const routineStatusStep of routineStatusSteps) {
    const comment = renderReviewCommentFromReport(
      `${reportFrontMatter({
        type: "pull_request",
        number: "74273",
        decision: "keep_open",
        close_reason: "none",
        work_candidate: "none",
        pull_head_sha: "abc123def460",
      })}

## Summary

Keep this PR open until normal merge gates pass.

## What This Changes

Updates review guidance.

## Best Possible Solution

${routineStatusStep}
`,
      "none",
    );

    assert.match(comment, /\*\*Next step before merge\*\*/);
    assert.match(
      comment,
      new RegExp(`- ${routineStatusStep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
    assert.doesNotMatch(
      comment,
      new RegExp(`\\[P[12]\\] ${routineStatusStep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
  }
});

test("pull request risk text keeps diff-caused CI risk actionable", () => {
  const actionableCiRisk = "The workflow change could cause CI checks to fail after merge.";
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "pull_request",
      number: "74270",
      decision: "keep_open",
      close_reason: "none",
      work_candidate: "none",
      pull_head_sha: "abc123def457",
    })}

## Summary

Keep this PR open while maintainers verify workflow behavior.

## What This Changes

Updates workflow handling.

## Best Possible Solution

Merge after the workflow risk is addressed.

## Risks / Open Questions

${actionableCiRisk}
`,
    "none",
  );

  assert.match(comment, /\*\*Risk before merge\*\*/);
  assert.match(
    comment,
    new RegExp(`- \\[P1\\] ${actionableCiRisk.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
});

test("pull request risk text keeps diff-caused status-check risk actionable", () => {
  const actionableStatusRisk = "The workflow change could cause status checks to fail after merge.";
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "pull_request",
      number: "74271",
      decision: "keep_open",
      close_reason: "none",
      work_candidate: "none",
      pull_head_sha: "abc123def458",
    })}

## Summary

Keep this PR open while maintainers verify workflow behavior.

## What This Changes

Updates workflow handling.

## Best Possible Solution

Merge after the status-check risk is addressed.

## Risks / Open Questions

${actionableStatusRisk}
`,
    "none",
  );

  assert.match(comment, /\*\*Risk before merge\*\*/);
  assert.match(
    comment,
    new RegExp(`- \\[P1\\] ${actionableStatusRisk.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
});

test("pull request risk text keeps diff-caused required-check risk actionable", () => {
  const actionableRequiredRisk =
    "The workflow change could cause required checks to fail after merge.";
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "pull_request",
      number: "74272",
      decision: "keep_open",
      close_reason: "none",
      work_candidate: "none",
      pull_head_sha: "abc123def459",
    })}

## Summary

Keep this PR open while maintainers verify workflow behavior.

## What This Changes

Updates workflow handling.

## Best Possible Solution

Merge after the required-check risk is addressed.

## Risks / Open Questions

${actionableRequiredRisk}
`,
    "none",
  );

  assert.match(comment, /\*\*Risk before merge\*\*/);
  assert.match(
    comment,
    new RegExp(`- \\[P1\\] ${actionableRequiredRisk.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
});

test("pull request risk text keeps broken passing-check risk actionable", () => {
  const actionablePassingRisks = [
    "The workflow change makes required checks pass even when tests fail.",
    "CI checks are passing despite tests failing.",
    "Security exposure remains even though status checks are green.",
    "CI checks are green but snapshot drift blocks merge.",
    "CI checks are green but the app crashes on startup.",
    "Status checks pass despite data loss.",
    "CI checks pass without running tests for the changed path.",
    "CI checks pass with tests disabled.",
    "Required checks pass after skipping the changed-path tests.",
    "CI checks pass without failures, but required docs are missing.",
    "CI checks pass and tests fail.",
    "Required checks pass and required docs are missing.",
    "Required checks pass and required approvals are complete, but required docs are missing.",
    "CI checks pass and required approvals are complete, but coverage is too low.",
    "CI checks pass because tests are mock-only.",
    "Status checks pass because validation is stubbed.",
    "CI checks pass but maintainer review is still required because tests were skipped.",
    "CI checks pass and required approvals are complete, but tests are disabled.",
    "CI checks pass with no tests for the changed path.",
    "CI checks are green with no validation.",
    "CI checks pass with only mocked tests.",
    "CI checks pass with insufficient coverage.",
    "CI checks pass and no tests run for this path.",
    "CI checks pass and no validation runs.",
    "CI checks pass and do not run tests for the changed path.",
    "CI checks pass and tests do not cover the changed path.",
    "CI checks pass and the changed path is untested.",
    "CI checks pass and a manual data migration is required before merge.",
  ];
  for (const actionablePassingRisk of actionablePassingRisks) {
    const comment = renderReviewCommentFromReport(
      `${reportFrontMatter({
        type: "pull_request",
        number: "74274",
        decision: "keep_open",
        close_reason: "none",
        work_candidate: "none",
        pull_head_sha: "abc123def461",
      })}

## Summary

Keep this PR open while maintainers verify workflow behavior.

## What This Changes

Updates workflow handling.

## Best Possible Solution

Merge after the required-check risk is addressed.

## Risks / Open Questions

${actionablePassingRisk}
`,
      "none",
    );

    assert.match(comment, /\*\*Risk before merge\*\*/);
    assert.match(
      comment,
      new RegExp(`- \\[P[01]\\] ${actionablePassingRisk.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
  }
});

test("OpenClaw pull request comments render PR surface inside evidence details", () => {
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      repository: "openclaw/openclaw",
      type: "pull_request",
      number: "12345",
      decision: "keep_open",
      close_reason: "none",
      work_candidate: "none",
      pr_surface_files: JSON.stringify([
        { path: "src/runtime.ts", additions: 10, deletions: 2 },
        { path: "src/runtime.test.ts", additions: 7, deletions: 1 },
        { path: "docs/usage.md", additions: 4, deletions: 0 },
      ]),
      pr_surface_files_truncated: "false",
      review_metrics: JSON.stringify([]),
    })}

## Summary

Keep this PR open for maintainer review.

## What This Changes

Adds a small runtime change with tests and docs.
`,
    "none",
  );

  const evidenceDetails = detailsBody(comment, "Evidence reviewed");
  const visibleBeforeEvidence = comment.slice(
    0,
    comment.indexOf("<summary>Evidence reviewed</summary>"),
  );

  assert.match(
    visibleBeforeEvidence,
    /PR surface: Source \+8, Tests \+6, Docs \+4\. Total \+18 across 3 files\./,
  );
  assert.doesNotMatch(visibleBeforeEvidence, /<summary>View PR surface stats<\/summary>/);
  assert.doesNotMatch(
    visibleBeforeEvidence,
    /\| \*\*Total\*\* \| \*\*3\*\* \| \*\*21\*\* \| \*\*3\*\* \| \*\*\+18\*\* \|/,
  );
  assert.match(
    evidenceDetails,
    /PR surface:\n\nSource \+8, Tests \+6, Docs \+4\. Total \+18 across 3 files\./,
  );
  assert.match(evidenceDetails, /<summary>View PR surface stats<\/summary>/);
  assert.match(
    evidenceDetails,
    /\| \*\*Total\*\* \| \*\*3\*\* \| \*\*21\*\* \| \*\*3\*\* \| \*\*\+18\*\* \|/,
  );
  assert.match(comment, /\*\*Review metrics:\*\* none identified\./);
  assert.ok(comment.indexOf("PR surface:") < comment.indexOf("**Review metrics:**"));
  assert.ok(comment.indexOf("**Review metrics:**") < comment.indexOf("**Merge readiness**"));
});

test("pull request comments render one review metric digest item", () => {
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      repository: "openclaw/openclaw",
      type: "pull_request",
      number: "12345",
      decision: "keep_open",
      close_reason: "none",
      work_candidate: "none",
      review_metrics: JSON.stringify([
        {
          label: "Workflow surfaces changed",
          value: "1 workflow changed",
          reason:
            "The PR changes repository automation behavior that maintainers should review before merge.",
        },
      ]),
    })}

## Summary

Keep this PR open for maintainer review.

## What This Changes

Updates repository automation.
`,
    "none",
  );

  assert.match(comment, /\*\*Review metrics:\*\* 1 noteworthy metric\./);
  assert.match(
    comment,
    /- \*\*Workflow surfaces changed:\*\* 1 workflow changed\. The PR changes repository automation behavior that maintainers should review before merge\./,
  );
});

test("pull request comments render multiple review metric digest items near PR surface", () => {
  const comment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      repository: "openclaw/openclaw",
      type: "pull_request",
      number: "12345",
      decision: "keep_open",
      close_reason: "none",
      work_candidate: "none",
      pr_surface_files: JSON.stringify([{ path: "src/runtime.ts", additions: 10, deletions: 2 }]),
      pr_surface_files_truncated: "false",
      review_metrics: JSON.stringify([
        {
          label: "Config/default surfaces changed",
          value: "2 added, 1 changed, 0 removed",
          reason:
            "The PR introduces user-facing configuration behavior that maintainers should review before merge.",
        },
        {
          label: "Proof files affected",
          value: "3 files affected",
          reason:
            "The PR touches proof-related code where green unit tests do not cover every runtime path.",
        },
      ]),
    })}

## Summary

Keep this PR open for maintainer review.

## What This Changes

Adds configuration behavior and proof updates.
`,
    "none",
  );

  assert.match(comment, /\*\*Review metrics:\*\* 2 noteworthy metrics\./);
  assert.match(
    comment,
    /- \*\*Config\/default surfaces changed:\*\* 2 added, 1 changed, 0 removed\./,
  );
  assert.match(comment, /- \*\*Proof files affected:\*\* 3 files affected\./);
  assert.ok(comment.indexOf("PR surface:") < comment.indexOf("**Review metrics:**"));
  assert.ok(comment.indexOf("**Review metrics:**") < comment.indexOf("**Merge readiness**"));
});

test("PR surface is OpenClaw pull-request only", () => {
  const frontMatter = {
    decision: "keep_open",
    close_reason: "none",
    work_candidate: "none",
    pr_surface_files: JSON.stringify([{ path: "src/runtime.ts", additions: 10, deletions: 2 }]),
    pr_surface_files_truncated: "false",
  };
  const body = `

## Summary

Keep this open.
`;

  const otherRepoComment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      ...frontMatter,
      repository: "example/project",
      type: "pull_request",
    })}${body}`,
    "none",
  );
  const issueComment = renderReviewCommentFromReport(
    `${reportFrontMatter({
      ...frontMatter,
      repository: "openclaw/openclaw",
      type: "issue",
    })}${body}`,
    "none",
  );

  assert.doesNotMatch(otherRepoComment, /PR surface:/);
  assert.doesNotMatch(issueComment, /PR surface:/);
});

function mergeRiskReviewComment({
  risk,
  options,
  bestSolution = "Resolve the merge risk before maintainers decide whether to land this PR.",
}: {
  risk: string;
  options: readonly Record<string, unknown>[];
  bestSolution?: string;
}): string {
  return renderReviewCommentFromReport(
    `${reportFrontMatter({
      type: "pull_request",
      number: "83400",
      decision: "keep_open",
      close_reason: "none",
      work_candidate: "none",
      pull_head_sha: "abc123def456",
      merge_risk_options: JSON.stringify(options),
    })}

## Summary

Keep this fail-closed provider-routing PR open for maintainer review.

## What This Changes

Changes missing Codex harness selection from fallback-tolerant behavior to a typed fail-closed error.

## Best Possible Solution

${bestSolution}

## Risks / Open Questions

${risk}

## Work Candidate

Candidate: none

Confidence: low

Priority: low

Status: none

Reason: Confirm whether this intentional fail-closed behavior is acceptable for existing fallback users.
`,
    "none",
  );
}

test("pull request keep-open review comments render repairable merge-risk options with one copy block", () => {
  const mergeRisk =
    "Existing users configured with a missing Codex harness would fail closed instead of continuing through their fallback model.";
  const comment = mergeRiskReviewComment({
    risk: mergeRisk,
    bestSolution:
      "Keep fallback behavior as the default and add a strict config option for the fail-closed behavior.",
    options: [
      {
        title: "Preserve existing behavior by default",
        body: "Keep fallback behavior as the default and add a strict config option for the fail-closed behavior.",
        category: "fix_before_merge",
        recommended: true,
        automergeInstruction:
          "Keep fallback behavior as the default and add a strict config option for the fail-closed behavior.",
      },
      {
        title: "Make the breaking change explicit",
        body: "Keep fail-closed behavior only if docs, tests, and release notes warn existing fallback users.",
        category: "fix_before_merge",
        recommended: false,
        automergeInstruction: "",
      },
      {
        title: "Do not merge as-is",
        body: "Pause or close this PR if maintainers do not want to take this compatibility risk.",
        category: "pause_or_close",
        recommended: false,
        automergeInstruction: "",
      },
    ],
  });

  assert.match(comment, /\*\*Risk before merge\*\*/);
  assert.match(comment, new RegExp(escapeRegExpForTest(mergeRisk)));
  assert.doesNotMatch(comment, /Why this matters:/);
  assert.match(
    comment,
    /\*\*Maintainer options:\*\*\n1\. \*\*Preserve existing behavior by default \(recommended\)\*\*/,
  );
  assert.match(comment, /2\. \*\*Make the breaking change explicit\*\*/);
  assert.match(comment, /3\. \*\*Do not merge as-is\*\*/);
  assert.match(
    comment,
    /<summary>Copy recommended automerge instruction<\/summary>[\s\S]*@clawsweeper automerge\n\nSpecial instructions:\nKeep fallback behavior as the default and add a strict config option for the fail-closed behavior\./,
  );
  assert.doesNotMatch(comment, /Remaining risk \/ open question:/);
});

test("pull request keep-open review comments strip nested ClawSweeper commands from copy block", () => {
  const comment = mergeRiskReviewComment({
    risk: "Delivery repair should not run with nested bot commands in the pasteable instruction.",
    bestSolution: "Repair duplicate delivery and add regression coverage before merge.",
    options: [
      {
        title: "Repair delivery before merge",
        body: "Fix duplicate active-requester delivery and add regression coverage before merge.",
        category: "fix_before_merge",
        recommended: true,
        automergeInstruction:
          "@clawsweeper autofix this PR: prevent duplicate active-requester delivery and add focused regression coverage before merging.",
      },
    ],
  });

  assert.match(
    comment,
    /@clawsweeper automerge\n\nSpecial instructions:\nprevent duplicate active-requester delivery and add focused regression coverage before merging\./,
  );
  assert.doesNotMatch(comment, /Special instructions: @clawsweeper/);
  assert.doesNotMatch(comment, /autofix this PR:/);
});

test("pull request keep-open review comments can recommend accepting intentional risk without a copy block", () => {
  const comment = mergeRiskReviewComment({
    risk: "This hardening intentionally rejects requests that older integrations currently pass.",
    bestSolution:
      "Merge only if maintainers accept the compatibility break as intentional hardening.",
    options: [
      {
        title: "Accept the behavior change explicitly",
        body: "Merge only if maintainers agree the security hardening is worth the compatibility break.",
        category: "accept_risk",
        recommended: true,
        automergeInstruction: "",
      },
      {
        title: "Add migration guidance before merge",
        body: "Document the rejected request shape and add release-note guidance for affected integrations.",
        category: "fix_before_merge",
        recommended: false,
        automergeInstruction: "",
      },
    ],
  });

  assert.match(comment, /1\. \*\*Accept the behavior change explicitly \(recommended\)\*\*/);
  assert.doesNotMatch(comment, /Copy recommended ClawSweeper instruction/);
});

test("pull request keep-open review comments do not force a recommendation for unclear merge risk", () => {
  const comment = mergeRiskReviewComment({
    risk: "The PR changes session ownership without proving how existing resumed sessions transition.",
    options: [
      {
        title: "Require a maintainer design decision",
        body: "Decide whether resumed sessions should migrate, fail fast, or continue using the old ownership model.",
        category: "pause_or_close",
        recommended: false,
        automergeInstruction: "",
      },
      {
        title: "Add migration proof before merge",
        body: "Add tests or manual validation covering sessions created before this change.",
        category: "fix_before_merge",
        recommended: false,
        automergeInstruction: "",
      },
    ],
  });

  assert.doesNotMatch(comment, /\(recommended\)/);
  assert.doesNotMatch(comment, /Copy recommended ClawSweeper instruction/);
});

test("pull request keep-open review comments allow multiple fix-before-merge options", () => {
  const comment = mergeRiskReviewComment({
    risk: "The retry path may duplicate queued user messages after partial provider sends.",
    bestSolution: "Guard retries with delivery state before merge.",
    options: [
      {
        title: "Guard retries with delivery state",
        body: "Track whether the user message was already sent before retrying provider fallback.",
        category: "fix_before_merge",
        recommended: true,
        automergeInstruction:
          "Track whether the user message was already sent before retrying provider fallback.",
      },
      {
        title: "Disable fallback after partial sends",
        body: "Fail fast once delivery starts instead of retrying through another provider.",
        category: "fix_before_merge",
        recommended: false,
        automergeInstruction: "",
      },
    ],
  });

  assert.match(comment, /1\. \*\*Guard retries with delivery state \(recommended\)\*\*/);
  assert.match(comment, /2\. \*\*Disable fallback after partial sends\*\*/);
  assert.match(comment, /@clawsweeper automerge/);
});

test("pull request keep-open review comments include pause or close when risk may outweigh value", () => {
  const comment = mergeRiskReviewComment({
    risk: "The PR changes automation proof capture without proving failed paths still upload artifacts.",
    options: [
      {
        title: "Prove artifact parity before merge",
        body: "Show that artifacts upload on success, failure, and skipped-review paths.",
        category: "fix_before_merge",
        recommended: false,
        automergeInstruction: "",
      },
      {
        title: "Pause or close",
        body: "Close this PR if maintainers decide the proof-capture regression risk outweighs the workflow cleanup.",
        category: "pause_or_close",
        recommended: false,
        automergeInstruction: "",
      },
    ],
  });

  assert.match(
    comment,
    /2\. \*\*Pause or close\*\*  \n   Close this PR if maintainers decide the proof-capture regression risk outweighs the workflow cleanup\./,
  );
  assert.doesNotMatch(comment, /Copy recommended ClawSweeper instruction/);
});

function escapeRegExpForTest(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("pull request review reports carry verdict and repair markers", () => {
  const markdown = `${reportFrontMatter({
    type: "pull_request",
    number: "74065",
    pull_head_sha: "abc123def456",
    decision: "keep_open",
    confidence: "high",
    work_candidate: "queue_fix_pr",
  })}

## Summary

Needs one more repair.
`;

  const markers = reviewAutomationMarkersFromReport(markdown);
  assert.match(markers, /clawsweeper-verdict:needs-changes/);
  assert.match(markers, /clawsweeper-action:fix-required/);
  assert.match(markers, /item=74065/);
  assert.match(markers, /sha=abc123def456/);
});

test("pull request reports without a repair candidate pause for human review", () => {
  const markers = reviewAutomationMarkersFromReport(`${reportFrontMatter({
    type: "pull_request",
    number: "74105",
    pull_head_sha: "abc123def456",
    decision: "keep_open",
    confidence: "high",
    work_candidate: "none",
  })}

## Summary

Needs maintainer review.
`);

  assert.match(markers, /clawsweeper-verdict:needs-human/);
  assert.doesNotMatch(markers, /clawsweeper-verdict:needs-changes/);
  assert.doesNotMatch(markers, /clawsweeper-action:fix-required/);
  assert.match(markers, /item=74105/);
  assert.match(markers, /sha=abc123def456/);
});

test("non-PR review reports do not carry repair markers", () => {
  assert.equal(reviewAutomationMarkersFromReport(reportFrontMatter({ type: "issue" })), "");
});
