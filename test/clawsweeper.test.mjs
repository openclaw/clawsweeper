import assert from "node:assert/strict";
import test from "node:test";

import {
  auditFromSnapshot,
  isProtectedItem,
  parseDecision,
  protectedLabels,
  reviewActionForDecision,
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
  const action = reviewActionForDecision({ item: item(), decision: closeDecision(), git });
  assert.equal(action.actionTaken, "proposed_close");
  assert.match(action.closeComment, /Closing this as implemented/);
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
  assert.equal(result.findings.missingOpen[0].number, 2);
  assert.equal(result.counts.openArchived, 1);
  assert.equal(result.findings.openArchived[0].closedPath, "closed/3.md");
  assert.equal(result.counts.staleItemRecords, 4);
  assert.equal(result.counts.duplicateRecords, 1);
  assert.equal(result.counts.protectedProposed, 1);
  assert.equal(result.counts.staleReviews, 1);
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
