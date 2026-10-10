import assert from "node:assert/strict";
import test from "node:test";

import {
  renderReviewCommentFromReport,
  reviewAutomationMarkersFromReport,
} from "../dist/clawsweeper.js";
import { detailsBody, reviewReportFrontMatter as reportFrontMatter } from "./helpers.ts";
import {
  prSurfaceFilesFromContext,
  prSurfaceFilesFromReport,
} from "../dist/clawsweeper-orchestration-foundation.js";
import { pinnedTestRolePaths } from "./openclaw-file-role-fixture.ts";

test("support-only surface moves +57 to Tests while the reviewer production metric stays intact", () => {
  const metric = {
    label: "Production vs test LOC",
    value: "production +0/-0; tests +57/-0",
    reason: "Synthetic reviewer assessment of the support-only change.",
  };
  const report = `${reportFrontMatter({
    type: "pull_request",
    number: "12345",
    work_candidate: "none",
    pr_surface_files: JSON.stringify([
      { path: pinnedTestRolePaths[0], additions: 57, deletions: 0 },
    ]),
    pr_surface_files_truncated: false,
    review_metrics: JSON.stringify([metric]),
  })}

## Summary

Updates test support.
`;
  const comment = renderReviewCommentFromReport(report, "none");
  assert.match(comment, /\| Source \| 0 \| 0 \| 0 \| 0 \|/);
  assert.match(comment, /\| Tests \| 1 \| 57 \| 0 \| \+57 \|/);
  assert.match(comment, /Total \+57 across 1 file\./);
  assert.ok(comment.includes(`| **${metric.label}** | ${metric.value} | ${metric.reason} |`));
  const truncated = renderReviewCommentFromReport(
    report.replace("pr_surface_files_truncated: false", "pr_surface_files_truncated: true"),
    "none",
  );
  assert.doesNotMatch(truncated, /View PR surface stats|\| Tests \|/);
  assert.ok(truncated.includes(metric.value));
});

test("security-needs-attention reports block unopted repair and automerge pass markers", () => {
  const securitySection = `
## Security Review

Status: needs_attention

Summary: The patch exposes a broader token scope and needs maintainer security review.

Concerns:

- **[high] Avoid broad token reuse:** \`src/auth/token.ts:42\`
  - body: The patch can reuse a token with broader scopes than the caller requested.
  - confidence: 0.91

## Review Findings

Overall correctness: patch is incorrect

Overall confidence: 0.99

Full review comments:

- none
`;
  const repairMarkers = reviewAutomationMarkersFromReport(`${reportFrontMatter({
    type: "pull_request",
    number: "74123",
    pull_head_sha: "abc123def456abc123def456abc123def456abcd",
    decision: "keep_open",
    confidence: "high",
    work_candidate: "queue_fix_pr",
  })}

## Summary

Needs a repair.

## Best Possible Solution

Merge after required checks are green.

${securitySection}
`);

  assert.match(repairMarkers, /clawsweeper-security:security-sensitive/);
  assert.match(repairMarkers, /clawsweeper-verdict:needs-human/);
  assert.doesNotMatch(repairMarkers, /clawsweeper-verdict:needs-changes/);
  assert.doesNotMatch(repairMarkers, /clawsweeper-action:fix-required/);

  const autofixRepairMarkers = reviewAutomationMarkersFromReport(`${reportFrontMatter({
    type: "pull_request",
    number: "74125",
    pull_head_sha: "abc789def123abc789def123abc789def123abcd",
    decision: "keep_open",
    confidence: "high",
    review_status: "complete",
    labels: JSON.stringify(["clawsweeper:autofix"]),
    work_candidate: "queue_fix_pr",
  })}

## Summary

Needs an opted-in repair.

## Best Possible Solution

Merge after required checks are green.

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
    pull_head_sha: "def456abc123def456abc123def456abc123abcd",
    decision: "keep_open",
    confidence: "high",
    review_status: "complete",
    labels: JSON.stringify(["clawsweeper:automerge"]),
    work_candidate: "none",
  })}

## Summary

Would otherwise pass automerge.

## Best Possible Solution

Merge after required checks are green.

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
      pull_head_sha: "abc123def456abc123def456abc123def456abcd",
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

  assert.match(comment, /## Before merge/);
  assert.ok(comment.includes(`- [ ] **Resolve merge risk** - ${duplicateRisk}`));
  assert.doesNotMatch(comment, /Remaining risk \/ open question:/);
  assert.doesNotMatch(comment, /### Merge-risk options/);
  assert.equal(comment.split(duplicateRisk).length - 1, 1);
});

test("every pull request merge risk is a blocked item without an inferred priority", () => {
  const risks = [
    "Blocked workflow actions could cause a data loss outage.",
    "Timeout fallback wording should remain scannable.",
    "CI checks are red on this branch and may be unrelated to the diff.",
    "CI checks pass but maintainer review is still required.",
  ];
  const report = `${reportFrontMatter({
    type: "pull_request",
    number: "74269",
    decision: "keep_open",
    close_reason: "none",
    review_status: "complete",
    work_candidate: "none",
    pull_head_sha: "abc123def456abc123def456abc123def456abcd",
  })}

## Summary

Keep this multi-risk PR open for maintainer review.

## What This Changes

Changes generated review-comment formatting.

## Best Possible Solution

Merge after required checks are green.

## Risks / Open Questions

${risks.map((risk) => `- ${risk}`).join("\n")}
`;
  const comment = renderReviewCommentFromReport(report, "none");
  const beforeMerge = comment.split("## Before merge\n\n")[1]?.split("\n## ")[0] ?? "";
  for (const risk of risks) {
    assert.ok(beforeMerge.includes(`- [ ] **Resolve merge risk** - ${risk}`), risk);
  }
  assert.doesNotMatch(comment, /\(P[0-3]\)|\[P[0-3]\]/);
  assert.equal((beforeMerge.match(/\*\*Resolve merge risk\*\*/g) ?? []).length, risks.length);
  assert.match(reviewAutomationMarkersFromReport(report), /clawsweeper-review-state:blocked/);
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

  const evidenceDetails = detailsBody(comment, "Agent review details");
  const visibleBeforeEvidence = comment.slice(
    0,
    comment.indexOf("<summary><strong>Agent review details</strong></summary>"),
  );

  assert.doesNotMatch(visibleBeforeEvidence, /PR surface:/);
  assert.doesNotMatch(visibleBeforeEvidence, /<summary>View PR surface stats<\/summary>/);
  assert.doesNotMatch(
    visibleBeforeEvidence,
    /\| \*\*Total\*\* \| \*\*3\*\* \| \*\*21\*\* \| \*\*3\*\* \| \*\*\+18\*\* \|/,
  );
  assert.match(
    evidenceDetails,
    /### PR surface\n\nSource \+8, Tests \+6, Docs \+4\. Total \+18 across 3 files\./,
  );
  assert.match(evidenceDetails, /<summary>View PR surface stats<\/summary>/);
  assert.match(
    evidenceDetails,
    /\| \*\*Total\*\* \| \*\*3\*\* \| \*\*21\*\* \| \*\*3\*\* \| \*\*\+18\*\* \|/,
  );
  // An empty metrics digest is omitted rather than rendered as "None.".
  assert.doesNotMatch(evidenceDetails, /### Review metrics/);
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

  assert.match(comment, /### Review metrics/);
  assert.match(
    comment,
    /\| \*\*Workflow surfaces changed\*\* \| 1 workflow changed \| The PR changes repository automation behavior that maintainers should review before merge\. \|/,
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

  assert.match(comment, /### Review metrics/);
  assert.match(
    comment,
    /\| \*\*Config\/default surfaces changed\*\* \| 2 added, 1 changed, 0 removed \|/,
  );
  assert.match(comment, /\| \*\*Proof files affected\*\* \| 3 files affected \|/);
  assert.ok(comment.indexOf("### PR surface") < comment.indexOf("### Review metrics"));
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

function surfaceReport(files: unknown, truncated = false): string {
  return `${reportFrontMatter({
    repository: "openclaw/openclaw",
    type: "pull_request",
    decision: "keep_open",
    close_reason: "none",
    work_candidate: "none",
    pr_surface_files: JSON.stringify(files),
    pr_surface_files_truncated: String(truncated),
  })}\n\n## Summary\n\nReview completed.\n`;
}

test("PR surface context and report normalization preserve strict counts and exact paths", () => {
  const files = prSurfaceFilesFromContext({
    issue: {},
    comments: [],
    timeline: [],
    pullFiles: [
      { filename: " src/space.ts ", additions: 0, deletions: 0 },
      { filename: "src/max.ts", additions: Number.MAX_SAFE_INTEGER, deletions: 1 },
    ],
    counts: { comments: 0, timeline: 0, pullFiles: 2, pullFilesHydrated: 2 },
  });
  assert.deepEqual(files, [
    { path: " src/space.ts ", additions: 0, deletions: 0 },
    { path: "src/max.ts", additions: Number.MAX_SAFE_INTEGER, deletions: 1 },
  ]);
  assert.deepEqual(prSurfaceFilesFromReport(surfaceReport(files)), files);
  const zero = renderReviewCommentFromReport(surfaceReport([files![0]]), "none");
  assert.match(zero, /\| \*\*Total\*\* \| \*\*1\*\* \| \*\*0\*\* \| \*\*0\*\* \| \*\*0\*\* \|/);
});

test("PR surface states added test files from GitHub file status only", () => {
  const files = prSurfaceFilesFromContext({
    issue: {},
    comments: [],
    timeline: [],
    pullFiles: [
      { filename: "src/runtime.ts", additions: 4, deletions: 1, status: "modified" },
      { filename: "src/runtime.test.ts", additions: 9, deletions: 2, status: "modified" },
      { filename: "src/owner.test.ts", additions: 30, deletions: 0, status: "added" },
    ],
  });
  const comment = renderReviewCommentFromReport(surfaceReport(files), "none");
  assert.match(comment, /Total \+40 across 3 files\. Added test files: 1\./);
  // Reports written before file status was stored cannot tell added from changed.
  const legacy = files!.map(({ status: _status, ...file }) => file);
  assert.doesNotMatch(
    renderReviewCommentFromReport(surfaceReport(legacy), "none"),
    /Added test files/,
  );
});

test("PR surface missing or invalid statistics round-trip as unknown, never partial totals", () => {
  for (const value of [
    undefined,
    null,
    "",
    "0",
    "3",
    "invalid",
    false,
    {},
    [],
    -1,
    0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    for (const field of ["additions", "deletions"]) {
      const input = { filename: "src/unknown.ts", additions: 0, deletions: 0, [field]: value };
      const files = prSurfaceFilesFromContext({
        issue: {},
        comments: [],
        timeline: [],
        pullFiles: [input, { filename: "src/known.ts", additions: 4, deletions: 2 }],
      });
      assert.deepEqual(files?.[0], {
        path: input.filename,
        additions: 0,
        deletions: 0,
        [field]: null,
      });
      const report = surfaceReport(files);
      assert.deepEqual(prSurfaceFilesFromReport(report), files);
      // Old persisted reports may contain malformed values without passing through context extraction.
      const directReport = surfaceReport([
        { path: input.filename, additions: 0, deletions: 0, [field]: value },
        files![1],
      ]);
      assert.deepEqual(prSurfaceFilesFromReport(directReport), files);
      for (const candidate of [report, directReport]) {
        const comment = renderReviewCommentFromReport(candidate, "none");
        assert.match(comment, /PR surface statistics unavailable: complete line counts/);
        assert.doesNotMatch(comment, /\| \*\*Total\*\* \|/);
      }
    }
  }
});

test("PR surface incomplete file lists cannot produce a numeric aggregate", () => {
  const file = { filename: "src/a.ts", additions: 1, deletions: 0 };
  for (const counts of [
    { pullFilesTruncated: true },
    { pullFiles: 2 },
    { pullFilesHydrated: 2 },
    { pullFiles: 0 },
    { pullFilesHydrated: 0 },
    { pullFiles: -1 },
    { pullFiles: null },
    { pullFiles: "1" },
  ]) {
    assert.equal(
      prSurfaceFilesFromContext({
        issue: {},
        comments: [],
        timeline: [],
        pullFiles: [file],
        counts: { comments: 0, timeline: 0, ...counts },
      }),
      null,
    );
  }
  for (const entry of [{ omitted: 1 }, { filename: "", additions: 0, deletions: 0 }, null]) {
    assert.equal(
      prSurfaceFilesFromContext({
        issue: {},
        comments: [],
        timeline: [],
        pullFiles: [file, entry],
      }),
      null,
    );
  }
  const known = { path: "src/a.ts", additions: 1, deletions: 0 };
  for (const report of [
    surfaceReport([known], true),
    surfaceReport([known, { omitted: 1 }]),
    surfaceReport([known, {}]),
    surfaceReport([known, null]),
    surfaceReport(null),
    surfaceReport({ files: [known] }),
    surfaceReport([known]).replace(/^pr_surface_files: .*$/m, 'pr_surface_files: [{"path":'),
  ]) {
    assert.equal(prSurfaceFilesFromReport(report), null);
    const comment = renderReviewCommentFromReport(report, "none");
    assert.match(comment, /PR surface statistics unavailable: the file list is incomplete/);
    assert.doesNotMatch(comment, /\| \*\*Total\*\* \|/);
  }
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
      pull_head_sha: "abc123def456abc123def456abc123def456abcd",
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

  assert.match(comment, /### Merge-risk options/);
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
    pull_head_sha: "abc123def456abc123def456abc123def456abcd",
    decision: "keep_open",
    confidence: "high",
    review_status: "complete",
    work_candidate: "queue_fix_pr",
  })}

## Summary

Needs one more repair.

## Best Possible Solution

Fix the durable review marker before merge.

## Review Findings

Overall correctness: patch is incorrect

Overall confidence: 0.99

Full review comments:

- none
`;

  const markers = reviewAutomationMarkersFromReport(markdown);
  assert.match(markers, /clawsweeper-verdict:needs-changes/);
  assert.match(markers, /clawsweeper-action:fix-required/);
  assert.match(markers, /item=74065/);
  assert.match(markers, /sha=abc123def456abc123def456abc123def456abcd/);
});

test("pull request reports without a repair candidate pause for human review", () => {
  const markers = reviewAutomationMarkersFromReport(`${reportFrontMatter({
    type: "pull_request",
    number: "74105",
    pull_head_sha: "abc123def456abc123def456abc123def456abcd",
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
  assert.match(markers, /sha=abc123def456abc123def456abc123def456abcd/);
});

test("non-PR review reports do not carry repair markers", () => {
  assert.equal(reviewAutomationMarkersFromReport(reportFrontMatter({ type: "issue" })), "");
});
