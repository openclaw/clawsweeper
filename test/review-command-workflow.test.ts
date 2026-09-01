import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { useFakeScanner } from "./agent-input-scan-helpers.ts";
import { runAgentCheckoutInspection, runAgentProcess } from "../dist/agent-runner.js";
import { createReviewActionLedger } from "../dist/clawsweeper-review-ledger.js";
import { readAllSpooledActionEvents } from "../dist/action-ledger.js";
import { closeDecision } from "./helpers.ts";
import { AgentInputScanError } from "../dist/agent-input-scan.js";

import { parseArgs } from "../dist/clawsweeper-args.js";
import {
  createReviewCommandWorkflow,
  localExactBootstrapReviewCommentBody,
  withRunnerPreflightProvenance,
} from "../dist/clawsweeper-review-command-workflow.js";
import {
  isSuppliedReviewStartLease,
  reviewLeaseStillMatchesContext,
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

function structuralRecord(
  activityUpdatedAt: string,
  pull: ReviewStructuralSnapshot["pull"] = null,
) {
  const snapshot: ReviewStructuralSnapshot = {
    repo: REPO,
    number: ITEM_NUMBER,
    kind: pull ? "pull_request" : "issue",
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
    pull,
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

for (const scenario of [
  "structural-clean",
  "structural-refusal",
  "content-refusal",
  "changed-pr-refusal",
  "changed-pr-codex-failure",
  "changed-pr-exact-codex-failure",
  "changed-pr-clean",
  "content-clean",
  "fresh-refusal",
]) {
  test(`scheduled ${scenario} preserves admission and terminal ledger classification`, (t) => {
    const refuseScan = scenario.endsWith("refusal");
    const codexFailure = scenario.endsWith("codex-failure");
    const exactFailure = scenario.includes("exact");
    const changedPr = scenario.startsWith("changed-pr-");
    const fresh = scenario === "fresh-refusal" || changedPr;
    const hydrated = fresh || scenario.startsWith("content-");
    if (refuseScan) useFakeScanner(t, "process.exit(183);");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "clawsweeper-scheduled-cache-")));
    const artifactDir = join(root, "artifacts");
    const itemsDir = join(root, "items");
    const target = join(root, "target");
    mkdirSync(target);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: target, encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.name", "Cache fixture");
    git("config", "user.email", "cache@example.invalid");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(target, "value.ts"), "const value = 1;\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const baseSha = git("rev-parse", "HEAD");
    writeFileSync(join(target, "value.ts"), "const value = 2; // sensitive-comment-marker\n");
    git("add", ".");
    git("commit", "-qm", "change");
    const headSha = git("rev-parse", "HEAD");
    const pull = changedPr
      ? {
          headSha,
          baseSha,
          draft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          additions: 1,
          deletions: 1,
          changedFiles: 1,
          commitCount: 1,
          checksDigest: digest("checks"),
          reviews: [],
          reviewsTruncated: false,
          reviewThreads: [],
          reviewThreadsTruncated: false,
        }
      : null;
    const priorRecord = structuralRecord(PRIOR_ACTIVITY_AT, pull);
    const currentRecord = structuralRecord(RESERVED_AT, pull);
    const patch = "@@ -1 +1 @@\n-const value = 1;\n+const value = 2; // sensitive-comment-marker";
    const context = {
      issue: { updatedAt: RESERVED_AT },
      sourceRevision: priorRecord.sourceRevision,
      comments: [],
      timeline: [],
      timelineRevision: "timeline",
      structuralItemStateDigest: currentRecord.itemStateDigest,
      previousClawSweeperReview: { verdictDigest: digest("previous") },
      ...(changedPr
        ? {
            pullRequest: {
              head: { sha: headSha },
              base: { sha: baseSha },
              draft: false,
              mergeable: "MERGEABLE",
              mergeableState: "CLEAN",
              additions: 1,
              deletions: 1,
              changedFiles: 1,
            },
            pullFiles: [
              {
                filename: "value.ts",
                status: "modified",
                additions: 1,
                deletions: 1,
                patch,
                baseMode: "100644",
                headMode: "100644",
                baseType: "blob",
                headType: "blob",
                treeModesComplete: true,
              },
            ],
            pullCommits: [],
            pullCommitsRevision: digest("commits"),
            pullReviewComments: [],
            pullReviewCommentsRevision: "reviews",
            pullChecks: {
              complete: true,
              checkRuns: [],
              statuses: [],
              checkRunsTruncated: false,
              statusesTruncated: false,
            },
            counts: {
              comments: 0,
              commentsTruncated: false,
              timeline: 0,
              timelineTruncated: false,
              pullFiles: 1,
              pullFilesHydrated: 1,
              pullFilesTruncated: false,
              pullCommits: 1,
              pullCommitsHydrated: 1,
              pullCommitsTruncated: false,
              pullReviewComments: 0,
              pullReviewCommentsTruncated: false,
            },
          }
        : {}),
    };
    const item = {
      repo: REPO,
      number: ITEM_NUMBER,
      kind: changedPr ? ("pull_request" as const) : ("issue" as const),
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

    const oldEnv = process.env;
    process.env = {
      ...oldEnv,
      CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
      CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-08-28",
      CLAWSWEEPER_ACTION_LEDGER_DISABLED: "0",
      CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "",
      GITHUB_REPOSITORY: REPO,
      GITHUB_WORKFLOW: "fixture",
      GITHUB_WORKFLOW_REF: "",
      GITHUB_RUN_ID: "100",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_JOB: "review",
      GITHUB_SHA: headSha,
      EXACT_REVIEW_ITEM_KEY: exactFailure ? `${REPO}#${ITEM_NUMBER}` : "",
    };
    t.after(() => {
      process.env = oldEnv;
    });
    const ledgerOwner = createReviewActionLedger({
      root,
      targetRepo: () => REPO,
      repoRelativePath: () => `records/openclaw-openclaw/items/${ITEM_NUMBER}.md`,
      sha256: digest,
      isRuntimeBudgetError: () => false,
    });
    const providerCalls = join(root, "provider-calls");
    const provider = join(root, "codex");
    writeFileSync(
      provider,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(providerCalls)}, 'called'); process.exit(86);`,
      { mode: 0o700 },
    );

    const dependencies = {
      get activeReviewMutationRunner() {
        return activeReviewMutationRunner;
      },
      set activeReviewMutationRunner(value: unknown) {
        activeReviewMutationRunner = value;
      },
      ...ledgerOwner,
      CodexReviewError: class extends Error {},
      actionLedgerItemKey: (value: { repo: string; number: number }) =>
        `${value.repo}#${value.number}`,
      asRecord: (value: unknown) =>
        value && typeof value === "object" ? (value as Record<string, unknown>) : {},
      bulkFilerPolicyInvalidatesCachedReview: () => false,
      bulkFilerRepositoryPermission: () => null,
      buildLocalRangeReview: () => {
        throw new Error("local range must not run");
      },
      collectItemContext: () => {
        hydrationCalls += 1;
        if (!hydrated) throw new Error("scheduled structural cache hit must not hydrate");
        return context;
      },
      completePullChecksContext: (checks) => checks?.complete === true,
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
      displayPath: (value: string) => value,
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
        contentDigest: fresh ? digest("old-content") : digest("content"),
        lastFullReviewAt: new Date(Date.now() - 60_000).toISOString(),
        lastFullReviewDecision: "keep_open",
        structuralRecord: hydrated ? null : priorRecord,
      }),
      fetchReviewStructuralRecord: () => {
        structuralFetches += 1;
        return currentRecord;
      },
      finishReviewActionLedgerItem: (options: { completionReason?: string }) => {
        if (options.completionReason?.endsWith("_cache")) cachedCompletions += 1;
        return ledgerOwner.finishReviewActionLedgerItem(options);
      },
      freshDedicatedReviewStartLeases: (options: { headSha: string }) => {
        assert.equal(options.headSha, changedPr ? headSha : priorRecord.sourceRevision);
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
      frontMatterValue: (_markdown: string, key: string) =>
        key === "review_activity_cursor" ? `v2:0:${digest("activity")}` : undefined,
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
      reviewLeaseStillMatchesContext,
      liveClawSweeperReviewDigest: () => digest("previous"),
      stringOrUndefined: (value: unknown) => (typeof value === "string" ? value : undefined),
      itemContentDigest: () => (changedPr ? digest("different-content") : digest("content")),
      extractLatestClawSweeperReview: () => context.previousClawSweeperReview,
      fetchIssueReviewComments: () => [],
      pullHeadShaFromContext: (value) => value.pullRequest?.head.sha ?? null,
      reviewStructuralPullStateFromContext: () => pull,
      materializePullRequestReviewTree: ({ worktreeDir }) => {
        mkdirSync(worktreeDir, { recursive: true });
        git("clone", "-q", target, worktreeDir);
        return true;
      },
      removePullRequestReviewTree: () => true,
      localExactReviewItem: () => false,
      makeTreeReadOnly: () => [],
      postReviewStartStatusComment: () => {
        startCommentCalls += 1;
        throw new Error("scheduled delivery must not post a second lease");
      },
      previousClawSweeperReviewDigestFromReport: () => digest("previous"),
      replaceFrontMatterValue,
      repoFromArgs: () => ({ owner: "openclaw", repo: "openclaw" }),
      reportFileName: () => `${ITEM_NUMBER}.md`,
      reportReviewFindings: () => [],
      resolveReviewCheckout: () => ({ openclawDir: target }),
      restoreTreeModes: () => undefined,
      reviewCodexForcedLoginMethod: () => "chatgpt",
      reviewMutationRunner: () => null,
      reviewPolicyHash: () => POLICY,
      runReviewCheckoutInspection: (options) => {
        checkoutInspectionCalls += 1;
        if (refuseScan)
          return runAgentCheckoutInspection({
            cwd: options.openclawDir,
            env: { ...process.env, CODEX_BIN: provider },
            scanSource: options.scanSource,
            initialPrompt: options.initialPrompt,
            timeoutMs: options.timeoutMs,
          });
        return { status: 0, signal: null, stdout: "", stderr: "" };
      },
      prepareMediaProofArtifacts: () => ({ manifestPath: null, summaryPath: null, artifacts: [] }),
      buildReviewPrompt: () => ({ text: "Review the current item." }),
      itemSnapshotHash: () => digest("snapshot"),
      codexFailureLogKind: () => "codex_execution",
      codexReviewFailureRetryable: () => false,
      codexFailureDecision: () => {
        if (codexFailure) return closeDecision({ decision: "keep_open", closeReason: null });
        throw new Error("scan refusal must not become a decision");
      },
      runCodex: () => {
        generationCalls += 1;
        if (codexFailure) throw new Error("Codex process startup failed");
        if (fresh && refuseScan)
          return runAgentProcess({
            label: "fresh-review",
            cwd: target,
            prompt: "Review the current item.",
            scanSource: { kind: "prompt" },
            model: "internal",
            env: { ...process.env, CODEX_BIN: provider },
            timeoutMs: 30_000,
          });
        assert.equal(changedPr, true, "unchanged input must use the cache");
        return closeDecision({ decision: "keep_open", closeReason: null });
      },
      attachFixedPullRequest: (decision) => decision,
      verifyRegressionProvenance: (decision) => decision,
      reviewActionForDecision: () => ({ actionTaken: "none" }),
      markdownFor: () =>
        "---\nreview_status: complete\ndecision: keep_open\n---\nFresh Codex review\n",
      selectCandidates: () => ({ candidates: [{ ...item }], scannedPages: 1 }),
      suppliedReviewStartLeaseFromArgs,
      targetRepo: () => REPO,
      updateBulkFilerDetectedFrontMatter: (markdown: string) => markdown,
      updateReviewStructuralFrontMatter: (markdown: string) => markdown,
    } as never;

    try {
      const { reviewCommand } = createReviewCommandWorkflow(dependencies);
      const execute = () =>
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

      if (refuseScan) {
        assert.throws(execute, AgentInputScanError);
        assert.equal(checkoutInspectionCalls, fresh ? 0 : 1);
        assert.equal(hydrationCalls, hydrated ? 1 : 0);
        assert.equal(existsSync(providerCalls), false);
        const terminal = readAllSpooledActionEvents(root).filter(
          (event) => event.action.status === "failed",
        );
        assert.equal(terminal.length, 3);
        assert.ok(terminal.every((event) => event.action.retryable === false));
        assert.equal(cachedCompletions, 0);
        assert.equal(generationCalls, fresh ? 1 : 0);
        assert.equal(existsSync(join(artifactDir, `${ITEM_NUMBER}.md`)), false);
        return;
      }
      if (codexFailure) {
        assert.throws(execute, /Codex failed/);
        assert.equal(existsSync(join(artifactDir, "failure-diagnostics")), exactFailure);
        return;
      }
      execute();

      if (changedPr) {
        assert.equal(hydrationCalls, 1);
        assert.equal(generationCalls, 1);
        assert.equal(cachedCompletions, 0);
        assert.match(
          readFileSync(join(artifactDir, `${ITEM_NUMBER}.md`), "utf8"),
          /Fresh Codex review/,
        );
        return;
      }
      assert.equal(hydrationCalls, hydrated ? 1 : 0);
      assert.equal(generationCalls, 0);
      assert.equal(startCommentCalls, 0);
      assert.ok(structuralFetches >= 2);
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
      assert.equal(metrics.structural_cache_hits, hydrated ? 0 : 1);
      assert.equal(metrics.content_cache_hits, hydrated ? 1 : 0);
      assert.equal(metrics.hydrations, hydrated ? 1 : 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
