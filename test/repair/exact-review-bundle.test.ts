import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  createExactReviewBundle,
  exactReviewDecisionSha256,
  validateExactReviewBundle,
  type ExactReviewBundleContext,
} from "../../dist/repair/exact-review-bundle.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-exact-review-"));
  const report = path.join(root, "42.md");
  const ledgerRoot = path.join(root, "ledger-root");
  const ledger = path.join(
    ledgerRoot,
    "ledger/v1/events/2026/07/15/openclaw/openclaw/events.jsonl",
  );
  fs.writeFileSync(report, "# Review\n\nVerified.\n");
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  fs.writeFileSync(ledger, '{"schema_version":1}\n');
  const context: ExactReviewBundleContext = {
    repository: "openclaw/clawsweeper",
    sourceSha: "a".repeat(40),
    runId: "29380556291",
    runAttempt: 2,
    producerJob: "event-review-apply",
    decisionSha256: exactReviewDecisionSha256(
      JSON.stringify({
        targetRepo: "openclaw/openclaw",
        targetBranch: "main",
        itemNumber: 42,
        itemKind: "issue",
      }),
    ),
    targetRepo: "openclaw/openclaw",
    targetBranch: "main",
    itemNumber: 42,
    itemKind: "issue",
    itemKey: "openclaw/openclaw#42",
    protocolVersion: 2,
    leaseRevision: 7,
    claimGeneration: 3,
    liveProceeded: true,
    liveTerminalNoop: false,
    liveTerminalMissing: false,
    liveGuardedOpen: false,
  };
  return { root, report, ledgerRoot, bundleDir: path.join(root, "bundle"), context };
}

test("exact review bundle binds immutable workflow and queue context", () => {
  const value = fixture();
  const created = createExactReviewBundle({
    bundleDir: value.bundleDir,
    reviewPath: value.report,
    actionLedgerRoot: value.ledgerRoot,
    createdAt: "2026-07-15T12:00:00Z",
    context: value.context,
  });
  const validated = validateExactReviewBundle(value.bundleDir, value.context);

  assert.deepEqual(validated, created);
  assert.equal(validated.review.artifact_present, true);
  assert.deepEqual(
    validated.files.map((file) => file.path),
    ["action-ledger/ledger/v1/events/2026/07/15/openclaw/openclaw/events.jsonl", "review/42.md"],
  );
});

test("exact review bundle rejects redirected and modified publication", () => {
  const value = fixture();
  createExactReviewBundle({
    bundleDir: value.bundleDir,
    reviewPath: value.report,
    actionLedgerRoot: value.ledgerRoot,
    createdAt: "2026-07-15T12:00:00Z",
    context: value.context,
  });

  assert.throws(
    () =>
      validateExactReviewBundle(value.bundleDir, {
        ...value.context,
        targetRepo: "openclaw/clawhub",
        itemKey: "openclaw/clawhub#42",
      }),
    /trusted workflow context/,
  );
  fs.appendFileSync(path.join(value.bundleDir, "review/42.md"), "changed\n");
  assert.throws(
    () => validateExactReviewBundle(value.bundleDir, value.context),
    /file inventory does not match/,
  );
});

test("exact review bundle rejects extras and symlinks", () => {
  const value = fixture();
  createExactReviewBundle({
    bundleDir: value.bundleDir,
    reviewPath: value.report,
    createdAt: "2026-07-15T12:00:00Z",
    context: value.context,
  });
  fs.writeFileSync(path.join(value.bundleDir, "payload.sh"), "exit 0\n");
  assert.throws(() => validateExactReviewBundle(value.bundleDir, value.context), /unexpected path/);

  fs.rmSync(path.join(value.bundleDir, "payload.sh"));
  fs.symlinkSync(value.report, path.join(value.bundleDir, "review", "43.md"));
  assert.throws(
    () => validateExactReviewBundle(value.bundleDir, value.context),
    /must not contain symlinks/,
  );
});

test("exact review decision digest ignores object key ordering", () => {
  assert.equal(
    exactReviewDecisionSha256('{"targetRepo":"openclaw/openclaw","itemNumber":42}'),
    exactReviewDecisionSha256('{"itemNumber":42,"targetRepo":"openclaw/openclaw"}'),
  );
});

test("exact review bundle requires a report after review proceeds", () => {
  const value = fixture();
  assert.throws(
    () =>
      createExactReviewBundle({
        bundleDir: value.bundleDir,
        createdAt: "2026-07-15T12:00:00Z",
        context: value.context,
      }),
    /requires a review artifact/,
  );
});

test("bundle validation uses the producer workflow identity across runs", () => {
  const value = fixture();
  createExactReviewBundle({
    bundleDir: value.bundleDir,
    reviewPath: value.report,
    createdAt: "2026-07-15T12:00:00Z",
    context: value.context,
  });
  const decision = JSON.stringify({
    targetRepo: value.context.targetRepo,
    targetBranch: value.context.targetBranch,
    itemNumber: value.context.itemNumber,
    itemKind: value.context.itemKind,
  });
  const result = spawnSync(
    process.execPath,
    ["dist/repair/exact-review-bundle-cli.js", "validate"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_REPOSITORY: value.context.repository,
        GITHUB_RUN_ID: "99999999",
        GITHUB_SHA: "b".repeat(40),
        EXACT_REVIEW_BUNDLE_DIR: value.bundleDir,
        EXACT_REVIEW_CLAIM_GENERATION: String(value.context.claimGeneration),
        EXACT_REVIEW_DECISION: decision,
        EXACT_REVIEW_GENERATION_ATTEMPT: String(value.context.runAttempt),
        EXACT_REVIEW_ITEM_KEY: value.context.itemKey,
        EXACT_REVIEW_ITEM_KIND: value.context.itemKind,
        EXACT_REVIEW_ITEM_NUMBER: String(value.context.itemNumber),
        EXACT_REVIEW_LEASE_REVISION: String(value.context.leaseRevision),
        EXACT_REVIEW_LIVE_GUARDED_OPEN: String(value.context.liveGuardedOpen),
        EXACT_REVIEW_LIVE_PROCEEDED: String(value.context.liveProceeded),
        EXACT_REVIEW_LIVE_TERMINAL_MISSING: String(value.context.liveTerminalMissing),
        EXACT_REVIEW_LIVE_TERMINAL_NOOP: String(value.context.liveTerminalNoop),
        EXACT_REVIEW_PRODUCER_JOB: value.context.producerJob,
        EXACT_REVIEW_PRODUCER_RUN_ID: value.context.runId,
        EXACT_REVIEW_PROTOCOL_VERSION: String(value.context.protocolVersion),
        EXACT_REVIEW_SOURCE_SHA: value.context.sourceSha,
        EXACT_REVIEW_TARGET_BRANCH: value.context.targetBranch,
        EXACT_REVIEW_TARGET_REPO: value.context.targetRepo,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
});
