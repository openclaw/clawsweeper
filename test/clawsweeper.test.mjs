import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  auditFromSnapshot,
  ghRetryKind,
  isProtectedItem,
  parseDecision,
  prepareMinimalCodexHome,
  protectedLabels,
  relatedTitleSearchTerms,
  reviewActionForDecision,
  safeOutputTail,
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

test("prepareMinimalCodexHome copies auth and config without user skills baggage", () => {
  const root = join(
    tmpdir(),
    `clawsweeper-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const sourceHome = join(root, "source-home");
  const sourceCodex = join(sourceHome, ".codex");
  mkdirSync(sourceCodex, { recursive: true });
  writeFileSync(join(sourceCodex, "auth.json"), '{"token":"x"}', "utf8");
  writeFileSync(join(sourceCodex, "config.toml"), 'provider = "smartingredients"', "utf8");
  writeFileSync(join(sourceCodex, "AGENTS.md"), "do not copy", "utf8");
  mkdirSync(join(sourceCodex, "skills"), { recursive: true });
  writeFileSync(join(sourceCodex, "skills", "dummy.txt"), "do not copy", "utf8");

  const isolatedHome = prepareMinimalCodexHome(sourceHome, join(root, "isolated-home"));
  const isolatedCodex = join(isolatedHome, ".codex");

  assert.equal(readFileSync(join(isolatedCodex, "auth.json"), "utf8"), '{"token":"x"}');
  assert.equal(
    readFileSync(join(isolatedCodex, "config.toml"), "utf8"),
    'provider = "smartingredients"',
  );
  assert.equal(existsSync(join(isolatedCodex, "AGENTS.md")), false);
  assert.equal(existsSync(join(isolatedCodex, "skills")), false);
});
