import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArgs } from "../dist/clawsweeper-args.js";
import {
  createReviewCommandWorkflow,
  localExactBootstrapReviewCommentBody,
  withRunnerPreflightProvenance,
} from "../dist/clawsweeper-review-command-workflow.js";
import {
  isSuppliedReviewStartLease,
  suppliedReviewStartLeaseFromArgs,
} from "../dist/clawsweeper-review-lease.js";
import { PUBLIC_CODEX_MODEL } from "../dist/codex-env.js";
import {
  createReviewStructuralRecord,
  type ReviewStructuralSnapshot,
} from "../dist/review-structural-cache.js";

const POLICY = "scheduled-cache-proof-policy";
const REPO = "openclaw/openclaw";
const ITEM_NUMBER = 1052;
const LEASE_OWNER = "github-run-123-1";
const LEASE_COMMENT_ID = 456;
const PRIOR_ACTIVITY_AT = "2026-08-07T10:00:00Z";
const RESERVED_AT = "2026-08-07T10:05:00Z";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function replaceFrontMatterValue(markdown: string, key: string, value: string): string {
  const line = `${key}: ${value}`;
  const pattern = new RegExp(`^${key}:\\s*.*$`, "m");
  return pattern.test(markdown)
    ? markdown.replace(pattern, line)
    : markdown.replace(/^---\n/, `---\n${line}\n`);
}

function structuralRecord(activityUpdatedAt: string) {
  const snapshot: ReviewStructuralSnapshot = {
    repo: REPO,
    number: ITEM_NUMBER,
    kind: "issue",
    nodeId: "I_scheduled_cache_proof",
    author: "contributor",
    authorAssociation: "CONTRIBUTOR",
    titleDigest: digest("scheduled cache proof"),
    bodyDigest: digest("unchanged body"),
    state: "OPEN",
    locked: false,
    labels: ["bug"],
    labelsTruncated: false,
    activityUpdatedAt,
    comments: [],
    commentsTruncated: false,
    timeline: [],
    timelineTruncated: false,
    relationSensitive: false,
    targetHeadSha: "a".repeat(40),
    latestReleaseTag: "v1.0.0",
    latestReleaseSha: "a".repeat(40),
    pull: null,
  };
  const record = createReviewStructuralRecord(snapshot, {
    reviewPolicy: POLICY,
    reviewModel: PUBLIC_CODEX_MODEL,
  });
  assert.ok(record);
  return record;
}

test("exact local bootstrap rejects a same-number report from another repository", () => {
  const report = [
    "---",
    `number: ${ITEM_NUMBER}`,
    "repository: openclaw/clawsweeper",
    "review_status: complete",
    "---",
    "Foreign report",
  ].join("\n");
  const frontMatterValue = (markdown: string, key: string): string | undefined =>
    markdown.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
  let renderCalls = 0;
  const render = () => {
    renderCalls += 1;
    return "rendered review history";
  };

  assert.equal(
    localExactBootstrapReviewCommentBody(
      report,
      { repo: "openclaw/clawsweeper", number: ITEM_NUMBER },
      frontMatterValue,
      render,
    ),
    "rendered review history",
  );
  assert.equal(
    localExactBootstrapReviewCommentBody(
      report,
      { repo: "openclaw/openclaw", number: ITEM_NUMBER },
      frontMatterValue,
      render,
    ),
    "",
  );
  assert.equal(
    localExactBootstrapReviewCommentBody(
      report,
      { repo: "openclaw/clawsweeper", number: ITEM_NUMBER + 1 },
      frontMatterValue,
      render,
    ),
    "",
  );
  assert.equal(renderCalls, 1);
});

test("cache preflight promotes legacy carried reports to runner-owned provenance", () => {
  const legacy = "---\nreview_status: complete\nlocal_checkout_access: unverified\n---\nLegacy";

  const promoted = withRunnerPreflightProvenance(legacy, replaceFrontMatterValue);

  assert.match(promoted, /^local_checkout_access: verified$/m);
  assert.match(promoted, /^local_checkout_access_source: runner_preflight_v1$/m);
});

test("scheduled delivery serves an unchanged item from the structural cache", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-scheduled-cache-"));
  const artifactDir = join(root, "artifacts");
  const itemsDir = join(root, "items");
  const priorRecord = structuralRecord(PRIOR_ACTIVITY_AT);
  const currentRecord = structuralRecord(RESERVED_AT);
  const item = {
    repo: REPO,
    number: ITEM_NUMBER,
    kind: "issue" as const,
    title: "Scheduled cache proof",
    url: `https://github.com/${REPO}/issues/${ITEM_NUMBER}`,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: PRIOR_ACTIVITY_AT,
    author: "contributor",
    authorAssociation: "CONTRIBUTOR",
    labels: ["bug"],
  };
  const leaseComment = {
    id: LEASE_COMMENT_ID,
    created_at: RESERVED_AT,
    updated_at: RESERVED_AT,
  };
  const priorMarkdown = "---\ndecision: keep_open\nreview_status: complete\n---\nCached review\n";
  let hydrationCalls = 0;
  let generationCalls = 0;
  let startCommentCalls = 0;
  let structuralFetches = 0;
  let cachedCompletions = 0;
  let checkoutInspectionCalls = 0;
  let activeReviewMutationRunner = null;

  const ledgerItem = {
    item,
    index: 0,
    started: true,
    startedAtMs: Date.now(),
    startEventId: null,
    lastEventId: null,
    logPublication: false,
    mutationAttemptCount: 0,
    mutationObserved: false,
    uncertainMutationObserved: false,
    terminal: false,
  };
  const ledger = {
    operationIdentity: {
      repository: REPO,
      reviewPolicy: POLICY,
      shardIndex: 0,
      shardCount: 1,
      candidateSnapshots: [],
    },
    batchStartEventId: null,
    items: new Map([[`${REPO}#${ITEM_NUMBER}`, ledgerItem]]),
    nextPhaseSeq: 1,
    mutationObserved: false,
    uncertainMutationObserved: false,
    startedAtMs: Date.now(),
    terminal: false,
  };

  const dependencies = {
    get activeReviewMutationRunner() {
      return activeReviewMutationRunner;
    },
    set activeReviewMutationRunner(value: unknown) {
      activeReviewMutationRunner = value;
    },
    actionLedgerFailureDisposition: () => ({
      status: "failed",
      reasonCode: "failed",
      completionReason: "failed",
    }),
    actionLedgerItemKey: (value: { repo: string; number: number }) =>
      `${value.repo}#${value.number}`,
    asRecord: (value: unknown) => value as Record<string, unknown>,
    bulkFilerPolicyInvalidatesCachedReview: () => false,
    bulkFilerRepositoryPermission: () => null,
    buildLocalRangeReview: () => {
      throw new Error("local range must not run");
    },
    collectItemContext: () => {
      hydrationCalls += 1;
      throw new Error("scheduled structural cache hit must not hydrate");
    },
    commentId: (comment: Record<string, unknown> | undefined) =>
      typeof comment?.id === "number" ? comment.id : null,
    DEFAULT_PLAN_BATCH_SIZE: 3,
    defaultItemsDir: () => itemsDir,
    defaultLocalRangeArtifactDir: () => artifactDir,
    defaultReviewArtifactDir: () => artifactDir,
    deleteOwnedDedicatedReviewStartLease: () => {
      throw new Error("the workflow-supplied lease is externally owned");
    },
    detectBulkFiler: () => ({ context: null, labelPending: false, labelApplied: false }),
    ensureDir: (path: string) => mkdirSync(path, { recursive: true }),
    existingReview: () => ({
      path: join(itemsDir, `${ITEM_NUMBER}.md`),
      markdown: priorMarkdown,
      reviewedAt: PRIOR_ACTIVITY_AT,
      itemUpdatedAt: PRIOR_ACTIVITY_AT,
      automationItemUpdatedAt: undefined,
      reviewCommentSyncedAt: "2026-08-07T10:01:00Z",
      labelsSyncedAt: "2026-08-07T10:02:00Z",
      decision: "keep_open",
      reviewStatus: "complete",
      reviewPolicy: POLICY,
      reviewModel: PUBLIC_CODEX_MODEL,
      itemSourceRevision: priorRecord.sourceRevision,
      contentDigest: digest("content"),
      lastFullReviewAt: new Date(Date.now() - 60_000).toISOString(),
      lastFullReviewDecision: "keep_open",
      structuralRecord: priorRecord,
      semanticRecord: null,
    }),
    fetchReviewStructuralRecord: () => {
      structuralFetches += 1;
      return currentRecord;
    },
    finishReviewActionLedger: () => undefined,
    finishReviewActionLedgerItem: (options: { completionReason?: string }) => {
      if (options.completionReason === "structural_cache") cachedCompletions += 1;
      return null;
    },
    freshDedicatedReviewStartLeases: (options: { headSha: string }) => {
      assert.equal(options.headSha, priorRecord.sourceRevision);
      return [
        {
          comment: leaseComment,
          startedAt: RESERVED_AT,
          expiresAt: "2026-08-07T11:05:00Z",
          owner: LEASE_OWNER,
          commentId: LEASE_COMMENT_ID,
        },
      ];
    },
    frontMatterValue: () => undefined,
    gitInfo: () => ({
      mainSha: "a".repeat(40),
      releaseStateComplete: true,
      latestRelease: null,
    }),
    isBulkFilerExemptAuthorAssociation: () => false,
    isBulkFilerExemptRepositoryPermission: () => false,
    issueReviewCommentState: () => ({
      comments: [leaseComment],
      reviewComment: undefined,
      leaseComment,
      leaseComments: [leaseComment],
      dedicatedLeaseComment: leaseComment,
      dedicatedLeaseComments: [leaseComment],
    }),
    isSuppliedReviewStartLease,
    liveClawSweeperReviewDigest: () => "same-review",
    localExactReviewItem: () => false,
    makeTreeReadOnly: () => [],
    postReviewStartStatusComment: () => {
      startCommentCalls += 1;
      throw new Error("scheduled delivery must not post a second lease");
    },
    previousClawSweeperReviewDigestFromReport: () => "same-review",
    replaceFrontMatterValue,
    repoFromArgs: () => ({ owner: "openclaw", repo: "openclaw" }),
    reportFileName: () => `${ITEM_NUMBER}.md`,
    reportReviewFindings: () => [],
    resolveReviewCheckout: () => ({ openclawDir: root }),
    restoreTreeModes: () => undefined,
    reviewCodexForcedLoginMethod: () => "chatgpt",
    reviewMutationRunner: () => null,
    reviewPolicyHash: () => POLICY,
    runReviewCheckoutInspection: () => {
      checkoutInspectionCalls += 1;
      return { status: 0, signal: null, stdout: "", stderr: "" };
    },
    runCodex: () => {
      generationCalls += 1;
      throw new Error("scheduled structural cache hit must not generate a review");
    },
    selectCandidates: () => ({ candidates: [{ ...item }], scannedPages: 1 }),
    startReviewActionLedger: () => ledger,
    startReviewActionLedgerItem: () => null,
    suppliedReviewStartLeaseFromArgs,
    targetRepo: () => REPO,
    updateBulkFilerDetectedFrontMatter: (markdown: string) => markdown,
    updateReviewStructuralFrontMatter: (markdown: string) => markdown,
  } as never;

  try {
    const { reviewCommand } = createReviewCommandWorkflow(dependencies);
    reviewCommand(
      parseArgs([
        "--target-repo",
        REPO,
        "--artifact-dir",
        artifactDir,
        "--items-dir",
        itemsDir,
        "--item-numbers",
        String(ITEM_NUMBER),
        "--readonly-openclaw",
        "--skip-start-comment",
        "--review-lease-owner",
        LEASE_OWNER,
        "--review-lease-comment-id",
        String(LEASE_COMMENT_ID),
        "--review-source-action",
        "scheduled_normal_backfill",
      ]),
    );

    assert.equal(hydrationCalls, 0);
    assert.equal(generationCalls, 0);
    assert.equal(startCommentCalls, 0);
    assert.equal(structuralFetches, 2);
    assert.equal(cachedCompletions, 1);
    assert.equal(checkoutInspectionCalls, 1);
    const carriedReportPath = join(artifactDir, `${ITEM_NUMBER}.md`);
    assert.equal(existsSync(carriedReportPath), true);
    const carriedReport = readFileSync(carriedReportPath, "utf8");
    assert.match(carriedReport, /^local_checkout_access: verified$/m);
    assert.match(carriedReport, /^local_checkout_access_source: runner_preflight_v1$/m);
    const metrics = JSON.parse(
      readFileSync(join(artifactDir, "review-cache-metrics.json"), "utf8"),
    );
    assert.equal(metrics.structural_cache_hits, 1);
    assert.equal(metrics.hydrations, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
