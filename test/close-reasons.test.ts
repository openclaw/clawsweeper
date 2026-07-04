import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import test from "node:test";

import {
  abandonedPrAgeSkipReason,
  closeReasonApplyAgeSkipReason,
  closeReasonsArg,
  compactReferencingMergedPullRequestForTest,
  formatRecentClosedRows,
  openClosingPullRequestApplyReason,
  referencingMergedPullRequestCandidatesForTest,
  referencingMergedPullRequestsForIssueForTest,
  reviewActionForDecision,
  sameAuthorCounterpartApplyReason,
  sanitizePublicSelfReferences,
  stalledUnprovenPrAgeSkipReason,
  stalledUnprovenProofRequestBlockReason,
  unconfirmedProductDirectionAgeSkipReason,
  unconfirmedProductDirectionCloseEnabled,
  validateCloseDecision,
} from "../dist/clawsweeper.js";
import { closeDecision, git, item, tmpPrefix, withMockGh } from "./helpers.ts";

test("invalid close semantics are rejected", () => {
  const mediumClose = reviewActionForDecision({
    item: item(),
    decision: closeDecision({ confidence: "medium" }),
    git,
  });
  assert.equal(mediumClose.actionTaken, "skipped_invalid_decision");

  const stalePr = validateCloseDecision(
    item({ kind: "pull_request" }),
    closeDecision({ closeReason: "stale_insufficient_info" }),
  );
  assert.equal(stalePr.ok, false);
  assert.equal(stalePr.actionTaken, "skipped_invalid_decision");

  const mostlyImplementedIssue = validateCloseDecision(
    item({ kind: "issue" }),
    closeDecision({ closeReason: "mostly_implemented_on_main" }),
  );
  assert.equal(mostlyImplementedIssue.ok, false);
  assert.equal(mostlyImplementedIssue.actionTaken, "skipped_invalid_decision");
  assert.equal(
    mostlyImplementedIssue.reason,
    "mostly_implemented_on_main is allowed only for pull requests",
  );

  const lowSignalIssue = validateCloseDecision(
    item({ kind: "issue" }),
    closeDecision({ closeReason: "low_signal_unmergeable_pr" }),
  );
  assert.equal(lowSignalIssue.ok, false);
  assert.equal(lowSignalIssue.actionTaken, "skipped_invalid_decision");
  assert.equal(
    lowSignalIssue.reason,
    "low_signal_unmergeable_pr is allowed only for pull requests",
  );

  const missingEvidence = validateCloseDecision(item(), closeDecision({ evidence: [] }));
  assert.equal(missingEvidence.ok, false);
  assert.equal(missingEvidence.actionTaken, "skipped_invalid_decision");

  const contradictoryClose = validateCloseDecision(
    item(),
    closeDecision({
      summary: "Keep open: this is useful but needs a wording fix before merge.",
      closeReason: "duplicate_or_superseded",
    }),
  );
  assert.equal(contradictoryClose.ok, false);
  assert.equal(contradictoryClose.actionTaken, "skipped_invalid_decision");
  assert.equal(contradictoryClose.reason, "close decision contains Keep open guidance");

  const missingSource = validateCloseDecision(
    item(),
    closeDecision({
      evidence: [
        {
          label: "claim",
          detail: "Looks implemented.",
          file: null,
          line: null,
          command: "rg feature",
          sha: null,
        },
      ],
    }),
  );
  assert.equal(missingSource.ok, false);
  assert.equal(missingSource.actionTaken, "skipped_invalid_decision");
});

test("unconfirmed product direction proposals require a clean external feature PR", () => {
  const decision = closeDecision({
    closeReason: "unconfirmed_product_direction",
    itemCategory: "feature",
    requiresNewFeature: true,
    requiresProductDecision: true,
    overallCorrectness: "patch is correct",
    securityReview: {
      status: "cleared",
      summary: "No security-sensitive behavior is involved.",
      concerns: [],
    },
    realBehaviorProof: {
      status: "sufficient",
      summary: "A real terminal transcript demonstrates the added behavior.",
      evidenceKind: "terminal",
      needsContributorAction: false,
    },
    prRating: {
      proofTier: "A",
      patchTier: "B",
      overallTier: "B",
      summary: "The patch is technically ready but product direction is unconfirmed.",
      nextSteps: [],
    },
  });
  const pullRequest = item({
    kind: "pull_request",
    url: "https://github.com/openclaw/openclaw/pull/123",
  });

  assert.deepEqual(validateCloseDecision(pullRequest, decision), { ok: true });
  assert.deepEqual(
    validateCloseDecision(
      {
        repo: pullRequest.repo,
        kind: pullRequest.kind,
        labels: pullRequest.labels,
        authorAssociation: pullRequest.authorAssociation,
      },
      decision,
    ),
    { ok: true },
  );
  assert.match(
    reviewActionForDecision({ item: pullRequest, decision, git }).closeComment,
    /product surface/,
  );
  assert.equal(
    validateCloseDecision(item({ ...pullRequest, labels: ["clawsweeper:human-review"] }), decision)
      .ok,
    false,
  );
  assert.equal(
    validateCloseDecision(item({ ...pullRequest, authorAssociation: "MEMBER" }), decision).ok,
    false,
  );
  assert.equal(
    validateCloseDecision(
      pullRequest,
      closeDecision({ ...decision, requiresProductDecision: false }),
    ).ok,
    false,
  );
  assert.equal(
    validateCloseDecision(
      pullRequest,
      closeDecision({
        ...decision,
        securityReview: {
          status: "cleared",
          summary: "One concern was recorded despite the cleared status.",
          concerns: [
            {
              title: "Permission boundary",
              body: "The new surface may cross an authorization boundary.",
              severity: "medium",
              confidenceScore: 0.8,
              file: "src/example.ts",
              line: 12,
            },
          ],
        },
      }),
    ).ok,
    false,
  );
  assert.equal(
    validateCloseDecision(
      pullRequest,
      closeDecision({
        ...decision,
        securityReview: {
          status: "not_applicable",
          summary: "No dedicated security review was completed.",
          concerns: [],
        },
      }),
    ).ok,
    false,
  );
  assert.equal(validateCloseDecision(item({ kind: "issue" }), decision).ok, false);
});

test("unconfirmed product direction apply policy is default-off and age-gated", () => {
  assert.equal(unconfirmedProductDirectionCloseEnabled({}), false);
  assert.equal(
    unconfirmedProductDirectionCloseEnabled({
      CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED: "true",
    }),
    true,
  );
  const now = Date.parse("2026-06-15T12:00:00Z");
  assert.equal(
    unconfirmedProductDirectionAgeSkipReason(
      item({ createdAt: "2026-06-01T11:59:59Z" }),
      "2026-06-01T00:00:00Z",
      "2026-06-08T00:00:01Z",
      now,
    ),
    null,
  );
  assert.match(
    unconfirmedProductDirectionAgeSkipReason(
      item({ createdAt: "2026-06-10T00:00:00Z" }),
      "2026-06-01T00:00:00Z",
      "2026-06-10T00:00:00Z",
      now,
    ) ?? "",
    /older than 14 days/,
  );
  assert.match(
    unconfirmedProductDirectionAgeSkipReason(
      item({ createdAt: "2026-05-01T00:00:00Z" }),
      "2026-06-07T00:00:00Z",
      "2026-06-14T00:00:00Z",
      now,
    ) ?? "",
    /7 days without source activity/,
  );
});

test("implemented-on-main closes require fix provenance", () => {
  const missingFixedSha = validateCloseDecision(
    item(),
    closeDecision({
      fixedSha: null,
    }),
  );
  assert.equal(missingFixedSha.ok, false);
  assert.equal(missingFixedSha.reason, "implemented_on_main requires fixedSha");

  const invalidFixedAt = validateCloseDecision(
    item(),
    closeDecision({
      fixedAt: "recently",
    }),
  );
  assert.equal(invalidFixedAt.ok, false);
  assert.equal(invalidFixedAt.reason, "implemented_on_main fixedAt must be an ISO timestamp");

  const dateOnlyFixedAt = validateCloseDecision(
    item(),
    closeDecision({
      fixedAt: "2026-04-28",
    }),
  );
  assert.equal(dateOnlyFixedAt.ok, false);
  assert.equal(dateOnlyFixedAt.reason, "implemented_on_main fixedAt must be an ISO timestamp");

  const missingReleaseOrTimestamp = validateCloseDecision(
    item(),
    closeDecision({
      fixedRelease: null,
      fixedAt: null,
    }),
  );
  assert.equal(missingReleaseOrTimestamp.ok, false);
  assert.equal(
    missingReleaseOrTimestamp.reason,
    "implemented_on_main requires fixedRelease or fixedAt",
  );

  const missingProvenanceEvidence = validateCloseDecision(
    item(),
    closeDecision({
      evidence: [
        {
          label: "implementation",
          detail: "The feature is present in source.",
          file: "src/example.ts",
          line: 12,
          command: null,
          sha: "abcdef1234567890",
        },
      ],
    }),
  );
  assert.equal(missingProvenanceEvidence.ok, false);
  assert.equal(
    missingProvenanceEvidence.reason,
    "implemented_on_main requires git history provenance evidence",
  );

  const missingReleaseStateEvidence = validateCloseDecision(
    item(),
    closeDecision({
      evidence: [
        {
          label: "implementation",
          detail: "The feature is present in source.",
          file: "src/example.ts",
          line: 12,
          command: null,
          sha: "abcdef1234567890",
        },
        {
          label: "git history provenance",
          detail: "git blame traced this line to the fixed commit.",
          file: "src/example.ts",
          line: 12,
          command: "git blame -L 12,12 -- src/example.ts",
          sha: "abcdef1234567890",
        },
      ],
    }),
  );
  assert.equal(missingReleaseStateEvidence.ok, false);
  assert.equal(
    missingReleaseStateEvidence.reason,
    "implemented_on_main requires release or main-only provenance evidence",
  );

  const blameAndMainTimestamp = validateCloseDecision(
    item(),
    closeDecision({
      fixedRelease: null,
      fixedAt: "2026-04-28T12:00:00Z",
      evidence: [
        {
          label: "implementation",
          detail: "The feature is present in source.",
          file: "src/example.ts",
          line: 12,
          command: null,
          sha: "abcdef1234567890",
        },
        {
          label: "git history provenance",
          detail: "git blame traced this line to the fixed commit.",
          file: "src/example.ts",
          line: 12,
          command: "git blame -L 12,12 -- src/example.ts",
          sha: "abcdef1234567890",
        },
        {
          label: "main-only release provenance",
          detail: "No shipped release tag contains the fix; current main includes it.",
          file: null,
          line: null,
          command: "git tag --contains abcdef1234567890",
          sha: "abcdef1234567890",
        },
      ],
    }),
  );
  assert.equal(blameAndMainTimestamp.ok, true);

  const mostlyImplementedPr = validateCloseDecision(
    item({ kind: "pull_request" }),
    closeDecision({
      closeReason: "mostly_implemented_on_main",
      summary: "Current main implements the useful part of this older PR.",
      closeComment:
        "Closing this older PR because current main already covers the useful change and the remaining branch diff is obsolete.",
    }),
  );
  assert.equal(mostlyImplementedPr.ok, true);

  const lowSignalPr = validateCloseDecision(
    item({ kind: "pull_request" }),
    closeDecision({
      closeReason: "low_signal_unmergeable_pr",
      summary: "The useful docs note is tiny, but the branch adds unrelated reference churn.",
      closeComment:
        "Closing this as low-signal unmergeable after Codex review.\n\n- Useful part: the clamp note is worth preserving in a narrow PR.\n- Unmergeable branch: most of this diff is unrelated copied reference material.",
    }),
  );
  assert.equal(lowSignalPr.ok, true);
});

test("low-signal unmergeable PR closes explain the narrow useful path", () => {
  const action = reviewActionForDecision({
    item: item({ kind: "pull_request" }),
    decision: closeDecision({
      closeReason: "low_signal_unmergeable_pr",
      summary:
        "The useful clamp documentation is small, but this branch is mostly unrelated reference churn.",
      evidence: [
        {
          label: "unrelated diff",
          detail:
            "The PR adds a large copied provider reference block while the stated docs fix is one field note.",
          file: "docs/gateway/configuration-reference.md",
          line: 95,
          command: "gh pr diff 72085 --repo openclaw/openclaw --name-only",
          sha: "588bf29604ffb0d599c5acb6417e962ae9f95e1f",
        },
      ],
      closeComment:
        "Closing this as low-signal unmergeable after Codex review.\n\n- Useful part: the clamp docs note is worth preserving.\n- Unmergeable branch: this branch adds a large unrelated reference block, so it is not a good landing base.",
    }),
    git,
  });

  assert.equal(action.actionTaken, "proposed_close");
  assert.match(action.closeComment, /not a good landing base/);
  assert.match(action.closeComment, /new narrow PR/);
  assert.match(action.closeComment, /useful clamp documentation is small/);
  assert.match(action.closeComment, /copied provider reference block/);
});

test("duplicate or superseded closes are allowed with evidence and comment", () => {
  const action = reviewActionForDecision({
    item: item(),
    decision: closeDecision({
      closeReason: "duplicate_or_superseded",
      summary: "Close as duplicate: an older open tracker already covers this.",
      bestSolution:
        "Keep the design thread on https://github.com/openclaw/openclaw/issues/63829, with https://github.com/openclaw/openclaw/pull/67584 as the active implementation path.",
      evidence: [
        {
          label: "canonical issue",
          detail: "Issue #456 tracks the same remaining work.",
          file: null,
          line: null,
          command: "provided GitHub related item context",
          sha: null,
        },
      ],
      closeComment:
        "Closing this as duplicate or superseded after Codex review.\n\n- Canonical issue: #456 tracks the same remaining work.",
    }),
    git,
  });
  assert.equal(action.actionTaken, "proposed_close");
  assert.match(action.closeComment, /duplicate or superseded/);
  assert.match(action.closeComment, /swept through the related work/);
  assert.match(
    action.closeComment,
    /Canonical path: Keep the design thread on https:\/\/github\.com\/openclaw\/openclaw\/issues\/63829, with https:\/\/github\.com\/openclaw\/openclaw\/pull\/67584 as the active implementation path\./,
  );
  assert.match(
    action.closeComment,
    /So I’m closing this here and keeping the remaining discussion on https:\/\/github\.com\/openclaw\/openclaw\/issues\/63829 and https:\/\/github\.com\/openclaw\/openclaw\/pull\/67584\./,
  );
  assert.ok(
    action.closeComment.indexOf("Canonical path:") <
      action.closeComment.indexOf("<details>\n<summary>Review details</summary>"),
  );
});

test("duplicate or superseded comments surface canonical refs appended to summary text", () => {
  const action = reviewActionForDecision({
    item: item(),
    decision: closeDecision({
      closeReason: "duplicate_or_superseded",
      summary: "Close as duplicate: an older tracker already covers this.",
      bestSolution:
        "Close as duplicate: an older tracker already covers this in https://github.com/openclaw/openclaw/issues/63829.",
      evidence: [
        {
          label: "canonical issue",
          detail: "Older tracker exists at https://github.com/openclaw/openclaw/issues/63829.",
        },
      ],
    }),
    git,
  });

  assert.equal(action.actionTaken, "proposed_close");
  assert.match(
    action.closeComment,
    /Canonical path: Close as duplicate: an older tracker already covers this in https:\/\/github\.com\/openclaw\/openclaw\/issues\/63829\./,
  );
});

test("duplicate or superseded comments prefer canonical refs over generic best solution", () => {
  const action = reviewActionForDecision({
    item: item(),
    decision: closeDecision({
      closeReason: "duplicate_or_superseded",
      summary: "Close as duplicate: an older tracker already covers this.",
      bestSolution: "Keep following the canonical issue.",
      evidence: [
        {
          label: "canonical issue",
          detail: "Older tracker exists at https://github.com/openclaw/openclaw/issues/63829.",
        },
      ],
    }),
    git,
  });

  assert.equal(action.actionTaken, "proposed_close");
  assert.match(
    action.closeComment,
    /Canonical path: Older tracker exists at https:\/\/github\.com\/openclaw\/openclaw\/issues\/63829\./,
  );
  assert.match(
    action.closeComment,
    /So I’m closing this here and keeping the remaining discussion on https:\/\/github\.com\/openclaw\/openclaw\/issues\/63829\./,
  );
});

test("duplicate or superseded close sentence surfaces multiple canonical refs", () => {
  const action = reviewActionForDecision({
    item: item(),
    decision: closeDecision({
      closeReason: "duplicate_or_superseded",
      summary:
        "Close as duplicate: the remaining timeout contract work is tracked in canonical timeout threads.",
      bestSolution: "Resolve timeout precedence in the canonical timeout-policy threads.",
      evidence: [
        {
          label: "Canonical provider-timeout issue remains open",
          detail:
            "Live GitHub context for https://github.com/openclaw/openclaw/issues/77744 covers provider timeout behavior.",
        },
        {
          label: "Canonical idle-timeout policy issue remains open",
          detail:
            "Live GitHub context for https://github.com/openclaw/openclaw/issues/78361 covers user-facing idle-timeout precedence.",
        },
      ],
    }),
    git,
  });

  assert.equal(action.actionTaken, "proposed_close");
  assert.match(
    action.closeComment,
    /So I’m closing this here and keeping the remaining discussion on https:\/\/github\.com\/openclaw\/openclaw\/issues\/77744 and https:\/\/github\.com\/openclaw\/openclaw\/issues\/78361\./,
  );
  assert.ok(
    action.closeComment.indexOf("https://github.com/openclaw/openclaw/issues/77744") <
      action.closeComment.indexOf("<details>\n<summary>Review details</summary>"),
  );
});

test("duplicate or superseded close sentence ignores ambiguous shorthand refs", () => {
  const action = reviewActionForDecision({
    item: item({ number: 123 }),
    decision: closeDecision({
      closeReason: "duplicate_or_superseded",
      summary: "Close #123 as duplicate of PR #456.",
      bestSolution: "Close #123 as duplicate of PR #456.",
      evidence: [
        {
          label: "canonical pull request",
          detail: "PR #456 tracks the same work.",
        },
      ],
    }),
    git,
  });

  assert.equal(action.actionTaken, "proposed_close");
  assert.match(
    action.closeComment,
    /So I’m closing this here because the remaining work is already tracked in the canonical issue\./,
  );
  assert.doesNotMatch(
    action.closeComment,
    /https:\/\/github\.com\/openclaw\/openclaw\/issues\/123/,
  );
  assert.doesNotMatch(
    action.closeComment,
    /https:\/\/github\.com\/openclaw\/openclaw\/issues\/456/,
  );
});

test("duplicate or superseded close sentence filters current item URLs", () => {
  const action = reviewActionForDecision({
    item: item({ number: 123 }),
    decision: closeDecision({
      closeReason: "duplicate_or_superseded",
      summary: "Close as duplicate of the canonical tracker.",
      bestSolution: "Keep remaining work on https://github.com/openclaw/openclaw/issues/456.",
      evidence: [
        {
          label: "Duplicate report context",
          detail:
            "https://github.com/openclaw/openclaw/issues/123 is the duplicate report being closed.",
        },
        {
          label: "Canonical issue",
          detail: "https://github.com/openclaw/openclaw/issues/456 tracks the same work.",
        },
      ],
    }),
    git,
  });

  assert.equal(action.actionTaken, "proposed_close");
  assert.match(
    action.closeComment,
    /So I’m closing this here and keeping the remaining discussion on https:\/\/github\.com\/openclaw\/openclaw\/issues\/456\./,
  );
  assert.doesNotMatch(
    action.closeComment,
    /So I’m closing this here and keeping the remaining discussion on https:\/\/github\.com\/openclaw\/openclaw\/issues\/123/,
  );
});

test("duplicate or superseded reference extraction ignores repeated malformed GitHub URLs", () => {
  const repeatedMalformedUrl = Array.from({ length: 100 }, () => "https://github.com/").join("");
  const action = reviewActionForDecision({
    item: item({ number: 123 }),
    decision: closeDecision({
      closeReason: "duplicate_or_superseded",
      summary: `Close as duplicate after checking ${repeatedMalformedUrl}.`,
      bestSolution: "Keep remaining work on https://github.com/openclaw/openclaw/issues/456.",
      evidence: [
        {
          label: "Malformed URL noise",
          detail: repeatedMalformedUrl,
        },
        {
          label: "Canonical issue",
          detail: "https://github.com/openclaw/openclaw/issues/456 tracks the same work.",
        },
      ],
    }),
    git,
  });

  assert.equal(action.actionTaken, "proposed_close");
  assert.match(
    action.closeComment,
    /So I’m closing this here and keeping the remaining discussion on https:\/\/github\.com\/openclaw\/openclaw\/issues\/456\./,
  );
});

test("duplicate or superseded close sentence includes duplicate-labeled canonical URL", () => {
  const action = reviewActionForDecision({
    item: item({ number: 123 }),
    decision: closeDecision({
      closeReason: "duplicate_or_superseded",
      summary: "Close as duplicate of the older tracker.",
      bestSolution: "Follow the linked duplicate tracker.",
      evidence: [
        {
          label: "Duplicate issue",
          detail: "https://github.com/openclaw/openclaw/issues/456 is the older open tracker.",
        },
      ],
    }),
    git,
  });

  assert.equal(action.actionTaken, "proposed_close");
  assert.match(
    action.closeComment,
    /So I’m closing this here and keeping the remaining discussion on https:\/\/github\.com\/openclaw\/openclaw\/issues\/456\./,
  );
});

test("apply close reason filters support exact fast-close lanes", () => {
  assert.equal(closeReasonsArg("all"), null);
  assert.deepEqual([...closeReasonsArg("implemented_on_main, duplicate_or_superseded")].sort(), [
    "duplicate_or_superseded",
    "implemented_on_main",
  ]);
  assert.throws(() => closeReasonsArg("stale"), /Invalid apply close reason: stale/);
});

test("stale and mostly-implemented closes require older items while implemented closes can be immediate", () => {
  const now = Date.parse("2026-04-28T12:00:00Z");
  const freshItem = item({ createdAt: "2026-04-28T11:59:00Z" });
  const oldItem = item({ createdAt: "2026-01-01T00:00:00Z" });

  assert.equal(
    closeReasonApplyAgeSkipReason(freshItem, "implemented_on_main", {
      minAgeMs: 0,
      minAgeDescription: "0 minutes",
      staleMinAgeDays: 60,
      now,
    }),
    null,
  );
  assert.equal(
    closeReasonApplyAgeSkipReason(freshItem, "duplicate_or_superseded", {
      minAgeMs: 5 * 60 * 1000,
      minAgeDescription: "5 minutes",
      staleMinAgeDays: 60,
      now,
    }),
    "created less than or equal to 5 minutes ago",
  );
  assert.equal(
    closeReasonApplyAgeSkipReason(freshItem, "stale_insufficient_info", {
      minAgeMs: 0,
      minAgeDescription: "0 minutes",
      staleMinAgeDays: 60,
      now,
    }),
    "stale_insufficient_info requires item older than 60 days",
  );
  assert.equal(
    closeReasonApplyAgeSkipReason(freshItem, "mostly_implemented_on_main", {
      minAgeMs: 0,
      minAgeDescription: "0 minutes",
      staleMinAgeDays: 60,
      now,
    }),
    "mostly_implemented_on_main requires item older than 60 days",
  );
  assert.equal(
    closeReasonApplyAgeSkipReason(oldItem, "mostly_implemented_on_main", {
      minAgeMs: 0,
      minAgeDescription: "0 minutes",
      staleMinAgeDays: 60,
      now,
    }),
    null,
  );
});

test("open PRs that close an issue block apply closes", () => {
  assert.equal(
    openClosingPullRequestApplyReason([
      { number: 69425, state: "open", title: "daemon: honor OPENCLAW_WRAPPER" },
    ]),
    "open PR #69425 (daemon: honor OPENCLAW_WRAPPER) is a closing reference",
  );
  assert.equal(
    openClosingPullRequestApplyReason([{ number: 69425, state: "closed", title: "done" }]),
    null,
  );
  assert.equal(
    openClosingPullRequestApplyReason(
      [{ number: 69425, state: "open", title: "daemon: honor OPENCLAW_WRAPPER" }],
      (number) => number === 69425,
    ),
    null,
  );
  assert.equal(
    openClosingPullRequestApplyReason(
      [
        {
          number: 69425,
          repo: "other/repo",
          state: "open",
          title: "daemon: honor OPENCLAW_WRAPPER",
        },
      ],
      (number, repo) => number === 69425 && repo === "openclaw/openclaw",
    ),
    "open PR #69425 (daemon: honor OPENCLAW_WRAPPER) is a closing reference",
  );
});

test("compactReferencingMergedPullRequest extracts fields from search API response", () => {
  const result = compactReferencingMergedPullRequestForTest({
    number: 87654,
    title: "fix: handle disconnect on shutdown",
    html_url: "https://github.com/openclaw/openclaw/pull/87654",
    body: "Fixes the disconnect issue. Refs #78419",
    user: { login: "contributor" },
    pull_request: { merged_at: "2026-04-01T10:00:00Z" },
  });
  assert.deepEqual(result, {
    number: 87654,
    title: "fix: handle disconnect on shutdown",
    url: "https://github.com/openclaw/openclaw/pull/87654",
    author: "contributor",
    mergedAt: "2026-04-01T10:00:00Z",
    body: "Fixes the disconnect issue. Refs #78419",
  });
});

test("compactReferencingMergedPullRequest handles null body", () => {
  // Compact function produces body:"" for null body; rows with null merged_at are filtered
  // out upstream by referencingMergedPullRequestCandidates before reaching this function.
  const result = compactReferencingMergedPullRequestForTest({
    number: 11111,
    title: "chore: bump deps",
    html_url: "https://github.com/openclaw/openclaw/pull/11111",
    body: null,
    user: { login: "bot" },
    pull_request: { merged_at: "2026-01-01T00:00:00Z" },
  });
  assert.deepEqual(result, {
    number: 11111,
    title: "chore: bump deps",
    url: "https://github.com/openclaw/openclaw/pull/11111",
    author: "bot",
    mergedAt: "2026-01-01T00:00:00Z",
    body: "",
  });
});

test("compactReferencingMergedPullRequest truncates long bodies", () => {
  const longBody = "x".repeat(4000);
  const result = compactReferencingMergedPullRequestForTest({
    number: 22222,
    title: "refactor: big change",
    html_url: "https://github.com/openclaw/openclaw/pull/22222",
    body: longBody,
    user: { login: "alice" },
    pull_request: { merged_at: "2026-01-01T00:00:00Z" },
  });
  const body = (result as { body: string }).body;
  assert.ok(body.length < 4000, "body should be shorter than the original 4000 chars");
  assert.ok(body.length > 0, "body should be non-empty");
});

test("referencingMergedPullRequestCandidates keeps only items with non-null pull_request.merged_at", () => {
  const items = [
    // kept: PR with merge timestamp
    {
      number: 1,
      title: "fix: real fix",
      html_url: "https://github.com/openclaw/openclaw/pull/1",
      body: "Refs #999",
      user: { login: "alice" },
      pull_request: { merged_at: "2026-03-01T10:00:00Z" },
    },
    // dropped: issue (no pull_request field)
    {
      number: 2,
      title: "bug: still broken",
      html_url: "https://github.com/openclaw/openclaw/issues/2",
      body: "body",
      user: { login: "bob" },
    },
    // dropped: PR shape present but merged_at is null
    {
      number: 3,
      title: "wip: not merged",
      html_url: "https://github.com/openclaw/openclaw/pull/3",
      body: "",
      user: { login: "carol" },
      pull_request: { merged_at: null },
    },
  ];
  const result = referencingMergedPullRequestCandidatesForTest(items);
  assert.equal(result.length, 1);
  assert.equal((result[0] as { number: number }).number, 1);
});

test("referencingMergedPullRequestCandidates returns empty for all-issue input", () => {
  const result = referencingMergedPullRequestCandidatesForTest([
    {
      number: 10,
      title: "issue",
      html_url: "https://github.com/openclaw/openclaw/issues/10",
      body: "",
      user: { login: "x" },
    },
  ]);
  assert.deepEqual(result, []);
});

test("referencingMergedPullRequestsForIssue returns [] when kill-switch env disables search", () => {
  const previous = process.env.CLAWSWEEPER_REFERENCING_PR_SEARCH;
  for (const value of ["0", "false", "no", "off", "disabled", "OFF"]) {
    process.env.CLAWSWEEPER_REFERENCING_PR_SEARCH = value;
    try {
      assert.deepEqual(
        referencingMergedPullRequestsForIssueForTest(78398),
        [],
        `kill-switch should accept "${value}"`,
      );
    } finally {
      if (previous === undefined) delete process.env.CLAWSWEEPER_REFERENCING_PR_SEARCH;
      else process.env.CLAWSWEEPER_REFERENCING_PR_SEARCH = previous;
    }
  }
});

test("referencingMergedPullRequestsForIssue swallows gh failures and returns []", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    withMockGh(
      root,
      `#!/usr/bin/env node\nprocess.stderr.write("simulated gh failure\\n"); process.exit(1);\n`,
      () => {
        assert.deepEqual(referencingMergedPullRequestsForIssueForTest(78398), []);
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("referencingMergedPullRequestsForIssue filters and compacts mixed gh response", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const ghMock = `#!/usr/bin/env node
console.log(JSON.stringify({
  items: [
    {
      number: 84209,
      title: "fix: handle disconnect",
      html_url: "https://github.com/openclaw/openclaw/pull/84209",
      body: "Refs #78398",
      user: { login: "alice" },
      pull_request: { merged_at: "2026-03-04T12:00:00Z" }
    },
    {
      number: 84210,
      title: "issue, not a pr",
      html_url: "https://github.com/openclaw/openclaw/issues/84210",
      body: "mentions #78398",
      user: { login: "bob" }
    },
    {
      number: 84211,
      title: "pr, not merged",
      html_url: "https://github.com/openclaw/openclaw/pull/84211",
      body: "Refs #78398",
      user: { login: "carol" },
      pull_request: { merged_at: null }
    }
  ]
}));
`;
    withMockGh(root, ghMock, () => {
      const result = referencingMergedPullRequestsForIssueForTest(78398);
      assert.equal(result.length, 1);
      assert.deepEqual(result[0], {
        number: 84209,
        title: "fix: handle disconnect",
        url: "https://github.com/openclaw/openclaw/pull/84209",
        author: "alice",
        mergedAt: "2026-03-04T12:00:00Z",
        body: "Refs #78398",
      });
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-author open issue and PR pairs block one-sided apply closes", () => {
  assert.equal(
    sameAuthorCounterpartApplyReason(item({ number: 42, author: "alice" }), [
      {
        issue: {
          number: 43,
          title: "Fix the same bug",
          state: "open",
          author: "alice",
        },
        pullRequest: {
          number: 43,
          title: "Fix the same bug",
          state: "open",
          author: "alice",
        },
      },
    ]),
    "open PR #43 (Fix the same bug) by the same author is paired with this issue",
  );
  assert.equal(
    sameAuthorCounterpartApplyReason(item({ number: 42, kind: "pull_request", author: "alice" }), [
      {
        localReport: {
          number: 41,
          kind: "issue",
          title: "Fix the same bug",
          author: "Alice",
          location: "items",
        },
      },
    ]),
    "open issue #41 (Fix the same bug) by the same author is paired with this PR",
  );
  assert.equal(
    sameAuthorCounterpartApplyReason(item({ number: 42, author: "alice" }), [
      { issue: { number: 43, title: "Different author", state: "open", author: "bob" } },
    ]),
    null,
  );
  assert.equal(
    sameAuthorCounterpartApplyReason(
      item({ number: 42, author: "alice" }),
      [
        {
          issue: {
            number: 43,
            title: "Fix the same bug",
            state: "open",
            author: "alice",
          },
          pullRequest: {
            number: 43,
            title: "Fix the same bug",
            state: "open",
            author: "alice",
          },
        },
      ],
      (number, kind) => number === 43 && kind === "pull_request",
    ),
    null,
  );
});

test("not-actionable-in-repo closes are allowed with evidence and comment", () => {
  const action = reviewActionForDecision({
    item: item(),
    decision: closeDecision({
      closeReason: "not_actionable_in_repo",
      evidence: [
        {
          label: "external administration",
          detail: "The request is for GitHub project settings, not OpenClaw source code.",
          file: null,
          line: null,
          command: "provided GitHub issue context",
          sha: null,
        },
      ],
      closeComment:
        "Closing this as not actionable in this repository after Codex review.\n\n- External administration: GitHub project settings are outside OpenClaw source code.",
    }),
    git,
  });
  assert.equal(action.actionTaken, "proposed_close");
  assert.match(action.closeComment, /Thanks for writing this up/);
  assert.match(action.closeComment, /outside the OpenClaw source shell/);
});

test("close reason labels keep incoherent distinct from not actionable in repo", () => {
  const rows = formatRecentClosedRows([
    {
      repo: "openclaw/openclaw",
      number: 1,
      kind: "issue",
      title: "Unclear report",
      closeReason: "incoherent",
      appliedAt: "2026-04-26T20:00:00.000Z",
      reportPath: "records/openclaw-openclaw/closed/1.md",
    },
    {
      repo: "openclaw/openclaw",
      number: 2,
      kind: "issue",
      title: "Repository settings request",
      closeReason: "not_actionable_in_repo",
      appliedAt: "2026-04-26T20:01:00.000Z",
      reportPath: "records/openclaw-openclaw/closed/2.md",
    },
  ]);

  assert.match(rows, /too unclear to act on/);
  assert.match(rows, /not actionable in this repository/);
  assert.doesNotMatch(rows, /\|\s*not actionable\s*\|/);
});

test("public comments avoid self-referencing the current item number", () => {
  const comment = sanitizePublicSelfReferences(
    "Issue #69400 is tracked by PR #69425, which says Fixes #69400. Close #69400 later.",
    69400,
    "issue",
  );

  assert.equal(
    comment,
    "This issue is tracked by PR #69425, which says Fixes this issue. Close this issue later.",
  );
});

function stalledUnprovenDecision(overrides = {}) {
  return closeDecision({
    closeReason: "stalled_unproven_pr",
    realBehaviorProof: {
      status: "missing",
      summary: "No real behavior proof was supplied after the review asked for it.",
      evidenceKind: "not_applicable",
      needsContributorAction: true,
    },
    prRating: {
      proofTier: "F",
      patchTier: "D",
      overallTier: "F",
      summary: "The patch is low quality and carries no real behavior proof.",
      nextSteps: [],
    },
    ...overrides,
  });
}

test("stalled_unproven_pr close decisions enforce proof, rating, and PR-only gates", () => {
  const ok = validateCloseDecision(item({ kind: "pull_request" }), stalledUnprovenDecision());
  assert.equal(ok.ok, true);

  const issueKind = validateCloseDecision(item({ kind: "issue" }), stalledUnprovenDecision());
  assert.equal(issueKind.ok, false);
  assert.equal(issueKind.reason, "stalled_unproven_pr is allowed only for pull requests");

  const maintainerAuthored = validateCloseDecision(
    item({ kind: "pull_request", authorAssociation: "MEMBER" }),
    stalledUnprovenDecision(),
  );
  assert.equal(maintainerAuthored.ok, false);
  assert.equal(
    maintainerAuthored.reason,
    "stalled_unproven_pr cannot close maintainer-authored pull requests",
  );

  const exemptLabel = validateCloseDecision(
    item({ kind: "pull_request", labels: ["clawsweeper:autofix"] }),
    stalledUnprovenDecision(),
  );
  assert.equal(exemptLabel.ok, false);
  assert.equal(
    exemptLabel.reason,
    "clawsweeper:autofix exempts this PR from stalled-unproven auto-close",
  );

  const sufficientProof = validateCloseDecision(
    item({ kind: "pull_request" }),
    stalledUnprovenDecision({
      realBehaviorProof: {
        status: "sufficient",
        summary: "A live transcript demonstrates the change.",
        evidenceKind: "terminal",
        needsContributorAction: false,
      },
    }),
  );
  assert.equal(sufficientProof.ok, false);
  assert.equal(
    sufficientProof.reason,
    "stalled_unproven_pr requires missing, mock-only, or insufficient real behavior proof",
  );

  const goodRating = validateCloseDecision(
    item({ kind: "pull_request" }),
    stalledUnprovenDecision({
      prRating: {
        proofTier: "C",
        patchTier: "B",
        overallTier: "B",
        summary: "The patch itself is in decent shape.",
        nextSteps: [],
      },
    }),
  );
  assert.equal(goodRating.ok, false);
  assert.equal(goodRating.reason, "stalled_unproven_pr requires a D or F overall PR rating");
});

test("abandoned_pr close decisions protect high-quality proven work", () => {
  const ok = validateCloseDecision(
    item({ kind: "pull_request" }),
    stalledUnprovenDecision({ closeReason: "abandoned_pr" }),
  );
  assert.equal(ok.ok, true);

  const issueKind = validateCloseDecision(
    item({ kind: "issue" }),
    stalledUnprovenDecision({ closeReason: "abandoned_pr" }),
  );
  assert.equal(issueKind.ok, false);
  assert.equal(issueKind.reason, "abandoned_pr is allowed only for pull requests");

  const provenQuality = validateCloseDecision(
    item({ kind: "pull_request" }),
    stalledUnprovenDecision({
      closeReason: "abandoned_pr",
      realBehaviorProof: {
        status: "sufficient",
        summary: "A live transcript demonstrates the change.",
        evidenceKind: "terminal",
        needsContributorAction: false,
      },
      prRating: {
        proofTier: "A",
        patchTier: "A",
        overallTier: "A",
        summary: "This is strong work that deserves repair or adoption instead.",
        nextSteps: [],
      },
    }),
  );
  assert.equal(provenQuality.ok, false);
  assert.equal(
    provenQuality.reason,
    "abandoned_pr cannot close a high-quality proven pull request",
  );

  const provenButMediocre = validateCloseDecision(
    item({ kind: "pull_request" }),
    stalledUnprovenDecision({
      closeReason: "abandoned_pr",
      realBehaviorProof: {
        status: "sufficient",
        summary: "Proof exists but the patch is mediocre.",
        evidenceKind: "terminal",
        needsContributorAction: false,
      },
      prRating: {
        proofTier: "B",
        patchTier: "C",
        overallTier: "C",
        summary: "Sufficient proof but only a C-grade patch.",
        nextSteps: [],
      },
    }),
  );
  assert.equal(provenButMediocre.ok, true);
});

test("stalled_unproven_pr apply requires an aged dated proof request", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const proofScript = (timelinePage: string, commentsPage: string) => `
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
if (args[0] === "api" && /\\/issues\\/321\\/timeline/.test(args[1] || "")) {
  console.log(JSON.stringify([${timelinePage}]));
} else if (args[0] === "api" && /\\/issues\\/321\\/comments/.test(args[1] || "")) {
  console.log(JSON.stringify([${commentsPage}]));
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    const now = Date.parse("2026-07-01T00:00:00Z");

    withMockGh(root, proofScript("[]", "[]"), () => {
      assert.equal(
        stalledUnprovenProofRequestBlockReason(321, now),
        "no visible dated proof request (needs-proof label event or proof nudge) on the live PR",
      );
    });

    const agedLabelEvent = `[{ event: "labeled", label: { name: "triage: needs-real-behavior-proof" }, created_at: "2026-05-01T00:00:00Z" }]`;
    withMockGh(root, proofScript(agedLabelEvent, "[]"), () => {
      assert.equal(stalledUnprovenProofRequestBlockReason(321, now), null);
    });

    const freshLabelEvent = `[{ event: "labeled", label: { name: "status: 📣 needs proof" }, created_at: "2026-06-25T00:00:00Z" }]`;
    withMockGh(root, proofScript(freshLabelEvent, "[]"), () => {
      assert.match(
        stalledUnprovenProofRequestBlockReason(321, now) ?? "",
        /proof request to be visible for 14 days/,
      );
    });

    const agedNudge = `[{ body: "<!-- clawsweeper-proof-nudge v1 -->\\nGentle proof reminder.", created_at: "2026-05-01T00:00:00Z" }]`;
    withMockGh(root, proofScript("[]", agedNudge), () => {
      assert.equal(stalledUnprovenProofRequestBlockReason(321, now), null);
    });

    const editedReviewCommentOnly = `[{ body: "<!-- clawsweeper-review v1 -->\\nPlease add real behavior proof.", created_at: "2026-05-01T00:00:00Z" }]`;
    withMockGh(root, proofScript("[]", editedReviewCommentOnly), () => {
      assert.match(
        stalledUnprovenProofRequestBlockReason(321, now) ?? "",
        /no visible dated proof request/,
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stalled PR close reasons gate apply on item age", () => {
  const created = "2026-05-01T00:00:00Z";
  const youngNow = Date.parse("2026-05-10T00:00:00Z");
  const oldNow = Date.parse("2026-07-01T00:00:00Z");

  assert.equal(
    stalledUnprovenPrAgeSkipReason({ createdAt: created }, youngNow),
    "stalled_unproven_pr requires PR older than 14 days",
  );
  assert.equal(stalledUnprovenPrAgeSkipReason({ createdAt: created }, oldNow), null);

  assert.equal(
    abandonedPrAgeSkipReason({ createdAt: created }, Date.parse("2026-05-20T00:00:00Z")),
    "abandoned_pr requires PR older than 30 days",
  );
  assert.equal(abandonedPrAgeSkipReason({ createdAt: created }, oldNow), null);
});
