import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  const liveProofDir = path.join(root, "live-proof");
  const ledger = path.join(
    ledgerRoot,
    "ledger/v1/events/2026/07/15/openclaw/openclaw/events.jsonl",
  );
  fs.writeFileSync(report, "# Review\n\nVerified.\n");
  fs.mkdirSync(liveProofDir);
  fs.writeFileSync(path.join(liveProofDir, "live-verification.json"), '{"schema_version":1}\n');
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
  return { root, report, ledgerRoot, liveProofDir, bundleDir: path.join(root, "bundle"), context };
}

function addHistoricalLiveProof(bundleDir: string, itemNumber: number, sourceDir: string): void {
  const relative = `live-proof/${itemNumber}/live-verification.json`;
  const source = path.join(sourceDir, "live-verification.json");
  const destination = path.join(bundleDir, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  const content = fs.readFileSync(destination);
  const manifestPath = path.join(bundleDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.files.push({
    path: relative,
    bytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  });
  manifest.files.sort((left: { path: string }, right: { path: string }) =>
    left.path.localeCompare(right.path),
  );
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

test("manual bundle policy is bound to the producer decision and original report time", () => {
  const value = fixture();
  const reviewedAt = "2026-08-01T01:02:03.000Z";
  const markdown = `---\npublication_policy: record_comment_only\nreviewed_at: ${reviewedAt}\n---\nReview\n`;
  fs.writeFileSync(value.report, markdown);
  const context = { ...value.context, publicationPolicy: "record_comment_only" as const };
  createExactReviewBundle({
    bundleDir: value.bundleDir,
    reviewPath: value.report,
    createdAt: "2026-09-01T00:00:00Z",
    context,
  });
  validateExactReviewBundle(value.bundleDir, context);
  assert.equal(fs.readFileSync(path.join(value.bundleDir, "review/42.md"), "utf8"), markdown);
  assert.throws(() => validateExactReviewBundle(value.bundleDir, value.context), /policy differs/);
  for (const policy of [
    "future_policy",
    "record_comment_only\npublication_policy: record_comment_only",
    "record_comment_only\npublicationPolicy: record_comment_only",
  ]) {
    fs.writeFileSync(value.report, `---\npublication_policy: ${policy}\n---\nReview\n`);
    assert.throws(
      () =>
        createExactReviewBundle({
          bundleDir: value.bundleDir,
          reviewPath: value.report,
          createdAt: "2026-09-01T00:00:00Z",
          context,
        }),
      /publication policy/,
    );
  }
});

test("selected bundle staging leaves normal producer diagnostics and sibling reports untouched", () => {
  const value = fixture();
  try {
    fs.writeFileSync(path.join(value.root, "selection.json"), '{"selected":[42]}\n');
    fs.writeFileSync(path.join(value.root, "review-cache-metrics.json"), "{}\n");
    fs.writeFileSync(path.join(value.root, "99.md"), "Unselected report\n");
    for (const directory of ["codex", "review-trees"]) {
      fs.mkdirSync(path.join(value.root, directory));
      fs.writeFileSync(path.join(value.root, directory, "diagnostic.txt"), "diagnostic\n");
    }
    const original = fs.readFileSync(value.report, "utf8");
    createExactReviewBundle({
      bundleDir: value.bundleDir,
      reviewPath: value.report,
      createdAt: "2026-09-07T00:00:00Z",
      context: value.context,
    });
    validateExactReviewBundle(value.bundleDir, value.context);
    assert.deepEqual(fs.readdirSync(path.join(value.bundleDir, "review")), ["42.md"]);
    assert.equal(fs.readFileSync(path.join(value.bundleDir, "review/42.md"), "utf8"), original);
    assert.equal(fs.readFileSync(value.report, "utf8"), original);
    assert.equal(fs.readFileSync(path.join(value.root, "99.md"), "utf8"), "Unselected report\n");
    for (const directory of ["codex", "review-trees"]) {
      assert.equal(
        fs.readFileSync(path.join(value.root, directory, "diagnostic.txt"), "utf8"),
        "diagnostic\n",
      );
    }
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("historical proof-bearing exact review bundles still validate", () => {
  const value = fixture();
  createExactReviewBundle({
    bundleDir: value.bundleDir,
    reviewPath: value.report,
    actionLedgerRoot: value.ledgerRoot,
    createdAt: "2026-07-15T12:00:00Z",
    context: value.context,
  });
  addHistoricalLiveProof(value.bundleDir, value.context.itemNumber, value.liveProofDir);
  const validated = validateExactReviewBundle(value.bundleDir, value.context);

  assert.equal(validated.review.artifact_present, true);
  assert.deepEqual(
    validated.files.map((file) => file.path),
    [
      "action-ledger/ledger/v1/events/2026/07/15/openclaw/openclaw/events.jsonl",
      "live-proof/42/live-verification.json",
      "review/42.md",
    ],
  );
});

test("new exact review bundle creation omits live-proof directories", () => {
  const value = fixture();
  const created = createExactReviewBundle({
    bundleDir: value.bundleDir,
    reviewPath: value.report,
    actionLedgerRoot: value.ledgerRoot,
    createdAt: "2026-07-15T12:00:00Z",
    context: value.context,
  });

  assert.equal(
    created.files.some((file) => file.path.startsWith("live-proof/")),
    false,
  );
  assert.equal(fs.existsSync(path.join(value.bundleDir, "live-proof")), false);
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
