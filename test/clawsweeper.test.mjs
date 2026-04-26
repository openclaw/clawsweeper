import assert from "node:assert/strict";
import test from "node:test";

import {
  applyDecisionPriority,
  auditFromSnapshot,
  auditHasStrictFailures,
  auditHealthSection,
  ghRetryKind,
  isCodexReviewCommentBody,
  isProtectedItem,
  itemNumbersArg,
  parseDecision,
  protectedLabels,
  relatedTitleSearchTerms,
  reviewActionForDecision,
  safeOutputTail,
  shardItemNumbers,
  shouldReviewItem,
  shouldRetryGh,
  shouldPlanItem,
  validateCloseDecision,
} from "../dist/clawsweeper.js";

function item(overrides = {}) {
  return {
    number: 123,
    kind: "issue",
    title: "Sample item",
    url: "https://github.com/openclaw/openclaw/issues/123",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    author: "contributor",
    authorAssociation: "NONE",
    labels: [],
    ...overrides,
  };
}

function closeDecision(overrides = {}) {
  return {
    decision: "close",
    closeReason: "implemented_on_main",
    confidence: "high",
    summary: "Current main already implements this.",
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
    risks: [],
    bestSolution: "Keep the implementation as-is.",
    fixedRelease: null,
    fixedSha: "abcdef1234567890",
    closeComment: "Closing this as implemented after Codex review.\n\n- Evidence.",
    ...overrides,
  };
}

const git = {
  mainSha: "abcdef1234567890",
  latestRelease: null,
};

function reportFrontMatter(overrides = {}) {
  const values = {
    type: "issue",
    decision: "keep_open",
    close_reason: "none",
    confidence: "high",
    action_taken: "kept_open",
    ...overrides,
  };
  return `---
${Object.entries(values)
  .map(([key, value]) => `${key}: ${value}`)
  .join("\n")}
---
`;
}

function auditRecord(number, overrides = {}) {
  return {
    number,
    location: "items",
    path: `items/${number}.md`,
    kind: "issue",
    title: `Item ${number}`,
    labels: [],
    decision: "keep_open",
    closeReason: "none",
    action: "kept_open",
    reviewStatus: "complete",
    currentState: undefined,
    ...overrides,
  };
}

test("protected labels are normalized and excluded from normal planning", () => {
  assert.deepEqual(protectedLabels(["Security", "bug", "maintainer", "SECURITY"]), [
    "security",
    "maintainer",
  ]);
  assert.equal(isProtectedItem(item({ labels: ["release-blocker"] })), true);
  assert.equal(shouldPlanItem(item({ labels: ["beta-blocker"] })), false);
  assert.equal(shouldPlanItem(item({ labels: ["bug"] })), true);
});

test("protected labels block close proposals even for otherwise valid decisions", () => {
  const validation = validateCloseDecision(item({ labels: ["security"] }), closeDecision());
  assert.equal(validation.ok, false);
  assert.equal(validation.actionTaken, "skipped_protected_label");

  const action = reviewActionForDecision({
    item: item({ labels: ["security"] }),
    decision: closeDecision(),
    git,
  });
  assert.equal(action.actionTaken, "skipped_protected_label");
  assert.equal(action.closeComment, "");
});

test("review actions only propose valid closes and never apply directly", () => {
  const action = reviewActionForDecision({
    item: item(),
    decision: closeDecision(),
    git,
    runtime: { model: "gpt-5.5", reasoningEffort: "high" },
  });
  assert.equal(action.actionTaken, "proposed_close");
  assert.match(action.closeComment, /Closing this as implemented/);
  assert.match(action.closeComment, /Codex Review notes: model gpt-5\.5, reasoning high;/);
});

test("review policy changes force fresh complete reports back into planning", () => {
  const reviewedAt = new Date().toISOString();
  const review = {
    path: "items/123.md",
    markdown: "",
    reviewedAt,
    itemUpdatedAt: "2026-01-01T00:00:00Z",
    decision: "keep_open",
    reviewStatus: "complete",
    reviewPolicy: "old-policy",
  };
  const now = Date.parse(reviewedAt) + 60_000;

  assert.equal(shouldReviewItem(item(), review, now, "new-policy"), true);
  assert.equal(shouldReviewItem(item(), review, now, "old-policy"), false);
});

test("hot new items review hourly before falling back to daily or weekly cadence", () => {
  const now = Date.parse("2026-04-26T12:00:00Z");
  const review = (reviewedAt, itemUpdatedAt) => ({
    path: "items/123.md",
    markdown: "",
    reviewedAt,
    itemUpdatedAt,
    decision: "keep_open",
    reviewStatus: "complete",
    reviewPolicy: "current",
  });

  assert.equal(
    shouldReviewItem(
      item({
        createdAt: "2026-04-24T00:00:00Z",
        updatedAt: "2026-04-24T00:00:00Z",
      }),
      review("2026-04-26T10:00:00Z", "2026-04-24T00:00:00Z"),
      now,
      "current",
    ),
    true,
  );
  assert.equal(
    shouldReviewItem(
      item({
        createdAt: "2026-04-24T00:00:00Z",
        updatedAt: "2026-04-24T00:00:00Z",
      }),
      review("2026-04-26T11:45:00Z", "2026-04-24T00:00:00Z"),
      now,
      "current",
    ),
    false,
  );
  assert.equal(
    shouldReviewItem(
      item({
        createdAt: "2026-03-01T00:00:00Z",
        updatedAt: "2026-03-01T00:00:00Z",
      }),
      review("2026-04-24T12:00:00Z", "2026-03-01T00:00:00Z"),
      now,
      "current",
    ),
    false,
  );
  assert.equal(
    shouldReviewItem(
      item({
        kind: "pull_request",
        createdAt: "2026-03-01T00:00:00Z",
        updatedAt: "2026-03-01T00:00:00Z",
      }),
      review("2026-04-25T10:00:00Z", "2026-03-01T00:00:00Z"),
      now,
      "current",
    ),
    true,
  );
});

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

  const missingEvidence = validateCloseDecision(item(), closeDecision({ evidence: [] }));
  assert.equal(missingEvidence.ok, false);
  assert.equal(missingEvidence.actionTaken, "skipped_invalid_decision");

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

test("duplicate or superseded closes are allowed with evidence and comment", () => {
  const action = reviewActionForDecision({
    item: item(),
    decision: closeDecision({
      closeReason: "duplicate_or_superseded",
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
  assert.match(action.closeComment, /not actionable in this repository/);
});

test("comment matcher recognizes old and new Codex review comments", () => {
  assert.equal(
    isCodexReviewCommentBody(
      "Closing this as implemented after Codex review.\n\nCodex Review notes: reviewed against abc.",
    ),
    true,
  );
  assert.equal(
    isCodexReviewCommentBody(
      "Codex automated review: keeping this open.\n\nBest possible solution:\n\nShip it.",
    ),
    true,
  );
  assert.equal(isCodexReviewCommentBody("Thanks for the report, I can reproduce this."), false);
});

test("item number args merge and sort workflow inputs", () => {
  assert.deepEqual(itemNumbersArg("42, 7, nope, 42", "5"), [5, 7, 42]);
  assert.deepEqual(itemNumbersArg("", undefined), []);
});

test("explicit item numbers shard targeted review runs", () => {
  assert.deepEqual(shardItemNumbers([5, 7, 42, 99], 2), [
    { shard: 0, itemNumbers: [5, 42] },
    { shard: 1, itemNumbers: [7, 99] },
  ]);
  assert.deepEqual(shardItemNumbers([5, 7], 50), [
    { shard: 0, itemNumbers: [5] },
    { shard: 1, itemNumbers: [7] },
  ]);
  assert.deepEqual(shardItemNumbers([], 50), [{ shard: 0, itemNumbers: [] }]);
});

test("apply mode prioritizes matching close proposals before comment sync", () => {
  const issueClose = reportFrontMatter({
    decision: "close",
    close_reason: "implemented_on_main",
    action_taken: "proposed_close",
  });
  const pullRequestClose = reportFrontMatter({
    type: "pull_request",
    decision: "close",
    close_reason: "implemented_on_main",
    action_taken: "proposed_close",
  });

  assert.equal(applyDecisionPriority(issueClose, "issue"), 0);
  assert.equal(applyDecisionPriority(pullRequestClose, "issue"), 1);
  assert.equal(applyDecisionPriority(reportFrontMatter(), "issue"), 2);
});

test("decision parser enforces required schema-shaped evidence", () => {
  assert.equal(parseDecision(closeDecision()).decision, "close");
  assert.throws(
    () =>
      parseDecision({
        ...closeDecision(),
        evidence: [{ label: "partial", detail: "missing nullable fields" }],
      }),
    /decision\.evidence\[0\]\.file/,
  );
});

test("review parser strips environment access caveats from risks", () => {
  const parsed = parseDecision(
    closeDecision({
      risks: [
        "GH_TOKEN was unavailable, so authenticated gh could not be used.",
        "A real product uncertainty remains.",
      ],
    }),
  );
  assert.deepEqual(parsed.risks, ["A real product uncertainty remains."]);
});

test("related title search terms keep issue-specific words", () => {
  assert.deepEqual(
    relatedTitleSearchTerms(
      "Feature: message:before_send hook to enable content-quality fallback gating",
    ),
    ["message", "before_send", "hook", "enable", "content-quality", "fallback"],
  );
});
test("audit detects live/local state drift and unsafe proposed records", () => {
  const result = auditFromSnapshot({
    openItems: [
      item({ number: 1, title: "tracked open" }),
      item({ number: 2, title: "missing open" }),
      item({ number: 3, title: "reopened archived" }),
    ],
    itemRecords: [
      auditRecord(1),
      auditRecord(4),
      auditRecord(5),
      auditRecord(6, {
        labels: ["security"],
        decision: "close",
        closeReason: "implemented_on_main",
        action: "proposed_close",
      }),
      auditRecord(7, { reviewStatus: "stale_local_checkout_blocked" }),
    ],
    closedRecords: [
      auditRecord(3, { location: "closed", path: "closed/3.md" }),
      auditRecord(5, { location: "closed", path: "closed/5.md" }),
    ],
    scanComplete: true,
    pagesScanned: 1,
    generatedAt: "2026-04-26T00:00:00.000Z",
  });

  assert.equal(result.counts.missingOpen, 1);
  assert.equal(result.counts.missingEligibleOpen, 1);
  assert.equal(result.counts.missingMaintainerOpen, 0);
  assert.equal(result.counts.missingProtectedOpen, 0);
  assert.equal(result.counts.missingRecentOpen, 0);
  assert.equal(result.findings.missingOpen[0].number, 2);
  assert.equal(result.findings.missingOpen[0].missingReason, "eligible");
  assert.equal(result.findings.missingEligibleOpen[0].number, 2);
  assert.equal(result.counts.openArchived, 1);
  assert.equal(result.findings.openArchived[0].closedPath, "closed/3.md");
  assert.equal(result.counts.staleItemRecords, 4);
  assert.equal(result.counts.duplicateRecords, 1);
  assert.equal(result.counts.protectedProposed, 1);
  assert.equal(result.counts.staleReviews, 1);
});

test("audit classifies missing open records by actionable reason", () => {
  const base = {
    itemRecords: [],
    closedRecords: [],
    scanComplete: true,
    pagesScanned: 1,
    generatedAt: "2026-04-26T12:00:00.000Z",
  };
  const expectedQueueLag = auditFromSnapshot({
    ...base,
    openItems: [
      item({ number: 1, authorAssociation: "MEMBER" }),
      item({ number: 2, labels: ["beta-blocker"] }),
      item({
        number: 3,
        createdAt: "2026-04-26T11:30:00.000Z",
        updatedAt: "2026-04-26T11:30:00.000Z",
      }),
    ],
  });

  assert.equal(expectedQueueLag.counts.missingOpen, 3);
  assert.equal(expectedQueueLag.counts.missingEligibleOpen, 0);
  assert.equal(expectedQueueLag.counts.missingMaintainerOpen, 1);
  assert.equal(expectedQueueLag.counts.missingProtectedOpen, 1);
  assert.equal(expectedQueueLag.counts.missingRecentOpen, 1);
  assert.deepEqual(
    expectedQueueLag.findings.missingOpen.map((finding) => finding.missingReason),
    ["maintainer_authored", "protected_label", "recently_created"],
  );
  assert.equal(auditHasStrictFailures(expectedQueueLag), false);

  const actionableDrift = auditFromSnapshot({
    ...base,
    openItems: [item({ number: 4, createdAt: "2026-04-24T00:00:00.000Z" })],
  });

  assert.equal(actionableDrift.counts.missingEligibleOpen, 1);
  assert.equal(actionableDrift.findings.missingEligibleOpen[0].missingReason, "eligible");
  assert.equal(auditHasStrictFailures(actionableDrift), true);
});

test("audit health section summarizes strict status and actionable findings", () => {
  const result = auditFromSnapshot({
    openItems: [
      item({
        number: 10,
        title: "eligible missing",
        createdAt: "2026-04-24T00:00:00.000Z",
      }),
      item({ number: 11, title: "reopened archived" }),
    ],
    itemRecords: [
      auditRecord(12, { title: "stale local" }),
      auditRecord(13, {
        title: "protected close",
        labels: ["security"],
        action: "proposed_close",
      }),
    ],
    closedRecords: [auditRecord(11, { location: "closed", path: "closed/11.md" })],
    scanComplete: true,
    pagesScanned: 1,
    generatedAt: "2026-04-26T12:00:00.000Z",
  });
  const section = auditHealthSection(result);

  assert.match(section, /### Audit Health/);
  assert.match(section, /<!-- clawsweeper-audit:start -->/);
  assert.match(section, /Status: \*\*Action needed\*\*/);
  assert.match(section, /\| Missing eligible open records \| 1 \|/);
  assert.match(section, /\[#10\]\(https:\/\/github\.com\/openclaw\/openclaw\/issues\/10\)/);
  assert.match(section, /Missing eligible open/);
  assert.match(section, /\[#13\]\(https:\/\/github\.com\/openclaw\/openclaw\/issues\/13\)/);
  assert.match(section, /Protected proposed close/);
  assert.match(section, /\[#11\]\(https:\/\/github\.com\/openclaw\/openclaw\/issues\/11\)/);
  assert.match(section, /Open archived/);
  assert.doesNotMatch(section, /\[#12\]\(https:\/\/github\.com\/openclaw\/openclaw\/issues\/12\)/);
});

test("audit defers stale item drift until the open scan is complete", () => {
  const result = auditFromSnapshot({
    openItems: [item({ number: 1 })],
    itemRecords: [auditRecord(1), auditRecord(2)],
    closedRecords: [],
    scanComplete: false,
    pagesScanned: 1,
    generatedAt: "2026-04-26T00:00:00.000Z",
  });

  assert.equal(result.scan.complete, false);
  assert.equal(result.counts.staleItemRecords, 0);
  assert.deepEqual(result.findings.staleItemRecords, []);
});

test("GitHub retry classifier distinguishes throttle and transient failures", () => {
  const throttled = new Error("API rate limit exceeded for user ID 1");
  assert.equal(ghRetryKind(throttled), "throttle");
  assert.equal(shouldRetryGh(throttled), true);

  const eof = Object.assign(new Error("Command failed: gh api repos/openclaw/openclaw/issues"), {
    stderr: 'Get "https://api.github.com/repos/openclaw/openclaw/issues?page=54": unexpected EOF\n',
  });
  assert.equal(ghRetryKind(eof), "transient");
  assert.equal(shouldRetryGh(eof), true);

  const connectionReset = new Error(
    "Post https://api.github.com/graphql: read: connection reset by peer",
  );
  assert.equal(ghRetryKind(connectionReset), "transient");

  const badGateway = Object.assign(new Error("gh: HTTP 502: Bad Gateway"), { stderr: "" });
  assert.equal(ghRetryKind(badGateway), "transient");

  const authFailure = Object.assign(new Error("gh: HTTP 401: Bad credentials"), {
    stderr: "Bad credentials",
  });
  assert.equal(ghRetryKind(authFailure), "none");
  assert.equal(shouldRetryGh(authFailure), false);

  const authFailureForIssue502 = Object.assign(
    new Error("Command failed: gh api repos/openclaw/openclaw/issues/502/comments"),
    { stderr: "gh: HTTP 401: Bad credentials" },
  );
  assert.equal(ghRetryKind(authFailureForIssue502), "none");
});

test("safeOutputTail tolerates missing process output", () => {
  assert.equal(safeOutputTail(undefined), "");
  assert.equal(safeOutputTail(null), "");
  assert.equal(safeOutputTail("abcdef", 3), "def");
});
