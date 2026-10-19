import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  prCloseCoverageProofGateResult,
  applyPrCloseCoverageProofReportSection,
} from "../dist/clawsweeper-coverage-proof.js";
import {
  prCloseCoverageProofCloseDecision,
  readPrCloseCoverageProofModelOutput,
} from "../dist/pr-close-coverage-proof.js";
import { withGitHubRun } from "../dist/clawsweeper-github-runtime.js";
import { executeApplyClose } from "../dist/clawsweeper-apply-close-execution.js";
import { validateCloseDecision } from "../dist/clawsweeper-close-decision.js";
import { createApplyRecordOperations } from "../dist/clawsweeper-apply-records.js";
import { publicationSafeReport, readReviewRecord } from "../dist/review-record.js";
import { prepareReviewCommentFromReport } from "../dist/clawsweeper-report-comment-presentation.js";
import { repositoryProfileFor, setTargetRepo } from "../dist/repository-profiles.js";
import { buildDecisionPacketFromReport } from "../dist/decision-packets.js";
import {
  item,
  lowSignalCloseReport,
  canonicalPullRequestClusterForTest,
  withReviewRecord,
  withMockGh,
  promotionGhMock,
} from "../test/helpers.ts";

// Run after building, with an absolute fresh directory outside the source checkout.
const root = resolve(process.argv[2]);
mkdirSync(root, { recursive: true });
const originalEnv = process.env;
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const hash = (value) => createHash("sha256").update(value).digest("hex");
const proof = {
  head,
  sourceDiffSha256: hash(execFileSync("git", ["diff", "HEAD", "--"], { encoding: "utf8" })),
  fixtureSourceMain: "e21c3b97dd6983f012a70d07b3bfde1e05ed2a12",
  provider: "local-macos",
  node: process.version,
  image: null,
  lease: null,
  scenarios: {},
};
try {
  const capability = ["synthetic", "authority", "diagnostic", "capability"].join("-");
  process.env = { ...originalEnv, GH_TOKEN: capability };
  setTargetRepo("openclaw/openclaw");
  const number = 348;
  const canonicalUrl = "https://github.com/openclaw/openclaw/pull/400";
  let markdown = withReviewRecord(
    lowSignalCloseReport({
      number,
      close_reason: "duplicate_or_superseded",
      root_cause_cluster: canonicalPullRequestClusterForTest(canonicalUrl),
    }),
    {
      closeReason: "duplicate_or_superseded",
      closeComment: `Closing as superseded by ${canonicalUrl}.`,
      rootCauseCluster: JSON.parse(canonicalPullRequestClusterForTest(canonicalUrl)),
    },
  );
  const subject = item({ number, kind: "pull_request" });
  const context = {
    issue: {},
    comments: [],
    timeline: [],
    pullRequest: { head: { sha: "a".repeat(40) } },
  };
  const workDir = join(root, "coverage");
  mkdirSync(workDir);
  const modeFile = join(root, "mode");
  const producer = join(root, "codex");
  writeFileSync(
    producer,
    `#!${process.execPath}
const fs = require('node:fs');
fs.readFileSync(0);
if (fs.readFileSync(${JSON.stringify(modeFile)}, 'utf8') === 'compromised') process.stderr.write(${JSON.stringify(capability)});
console.log(JSON.stringify({ sourceSummary: 'Source repairs the route.', coveringSummary: 'Canonical repairs the same route.', coveredWork: ['Canonical includes the route repair.'], uniqueSourceWork: [], decision: 'covered', reason: 'All source work is covered.' }));
`,
    { mode: 0o755 },
  );
  process.env.CODEX_BIN = producer;
  const runtime = {
    model: "Codex",
    reasoningEffort: "low",
    sandboxMode: "read-only",
    serviceTier: "",
    timeoutMs: 60_000,
    workDir,
    rootDir: root,
    schemaPath: resolve("schema/clawsweeper-pr-close-coverage-proof.schema.json"),
    promptTemplate: "Assess coverage of source by canonical.",
    ghToken: capability,
  };
  assert.ok(existsSync(runtime.schemaPath));
  const envelope = join(workDir, "348-400.proof.json");
  const runGate = (options) => withGitHubRun(() => prCloseCoverageProofGateResult(options));
  const closeProbe = (gate, dryRun) => {
    let closed = 0;
    let comments = 0;
    let skipped;
    const noop = () => null;
    const deps = new Proxy(
      {
        validateCloseDecision,
        ghJson: () => ({ body: "", labels: [], state: "open" }),
        fetchIssueReviewComments: () => [],
        closeReasonEnabled: () => true,
        applyPrCloseCoverageProofReportSection,
        closeItem: () => {
          closed++;
          throw new Error("External close forbidden");
        },
        ensureCloseAppliedComment: () => {
          comments++;
          return null;
        },
      },
      { get: (target, key) => target[key] ?? noop },
    );
    const options = new Proxy(
      {
        item: subject,
        number,
        repo: subject.repo,
        applyKind: "all",
        closeReason: "duplicate_or_superseded",
        dryRun,
        closeLimitReached: false,
        isRetryableSkippedClose: false,
        requiredMaintainerDecision: null,
        emitEventApplyProof: false,
        getMarkdown: () => markdown,
        setMarkdown: (value) => {
          markdown = value;
        },
        currentPrCloseCoverageProofGateBlock: () => (gate.status === "blocked" ? gate.block : null),
        proofResult: () => gate,
        markApplySkipped: (action, reason) => {
          skipped = { action, reason };
          return false;
        },
        recordApplySkipped: (action, reason) => {
          skipped = { action, reason };
          return false;
        },
        onClosed: () => false,
        runtimeBudget: {},
        examinedItemNumbers: [],
        minAgeMs: 0,
      },
      { get: (target, key) => target[key] ?? noop },
    );
    executeApplyClose(deps, options);
    assert.equal(closed, 0);
    return { closed, comments, skipped };
  };
  withMockGh(
    root,
    promotionGhMock({
      number,
      linkedPulls: {
        400: {
          number: 400,
          title: "Canonical route",
          html_url: canonicalUrl,
          state: "open",
          merged_at: null,
          labels: [],
        },
      },
    }),
    () => {
      writeFileSync(modeFile, "clean");
      const clean = runGate({ markdown, item: subject, context, runtime });
      assert.equal(clean.status, "allowed", JSON.stringify(clean));
      assert.ok(existsSync(envelope));
      const cleanClose = closeProbe(clean, true);
      assert.equal(cleanClose.comments, 1, JSON.stringify(cleanClose));
      assert.equal(cleanClose.skipped, undefined);
      proof.scenarios.clean = {
        gate: clean.status,
        envelopeCreated: true,
        dryRunCloseReached: true,
        closeWrites: cleanClose.closed,
      };
      // The clean proof is deliberately left on disk to exercise stale-envelope revocation.
      writeFileSync(modeFile, "compromised");
      const compromised = runGate({ markdown, item: subject, context, runtime });
      assert.equal(compromised.status, "blocked");
      assert.match(compromised.block.reason, /credential output was redacted/);
      assert.ok(!existsSync(envelope));
      const denial = readPrCloseCoverageProofModelOutput(join(workDir, "348-400.model.json"));
      assert.equal(prCloseCoverageProofCloseDecision(denial).close, false);
      const blockedClose = closeProbe(compromised, false);
      assert.equal(blockedClose.comments, 0);
      assert.match(blockedClose.skipped.reason, /credential output was redacted/);
      const reused = runGate({
        markdown,
        item: subject,
        context,
        runtime,
        requirePrecomputedProof: true,
      });
      assert.equal(reused.status, "blocked");
      assert.equal(closeProbe(reused, false).comments, 0);
      proof.scenarios.compromised = {
        gate: compromised.status,
        envelopePresent: false,
        persistedDecision: denial.decision,
        reusedGate: reused.status,
        commentWrites: blockedClose.comments,
        closeWrites: blockedClose.closed,
      };
    },
  );

  setTargetRepo("openclaw/clawsweeper");
  const stateRoot = join(root, "state");
  const itemsDir = join(stateRoot, "records/openclaw-clawsweeper/items");
  const packetsDir = join(stateRoot, "records/openclaw-clawsweeper/decision-packets");
  mkdirSync(itemsDir, { recursive: true });
  mkdirSync(packetsDir, { recursive: true });
  const reportPath = join(itemsDir, "123.md");
  writeFileSync(
    reportPath,
    JSON.parse(readFileSync("test/fixtures/reviewer-stable-report.json", "utf8")),
  );
  copyFileSync("test/fixtures/reviewer-stable-packet.json", join(packetsDir, "123.json"));
  const stableReport = readFileSync(reportPath, "utf8");
  const stablePacket = readFileSync(join(packetsDir, "123.json"), "utf8");
  assert.equal(readReviewRecord(stableReport).decision.decision, "keep_open");
  assert.equal(prepareReviewCommentFromReport(stableReport, "none").markdown, stableReport);
  assert.deepEqual(
    buildDecisionPacketFromReport(stableReport, {
      reportPath: "records/openclaw-clawsweeper/items/123.md",
    }),
    JSON.parse(stablePacket),
  );
  const denyGh = join(root, "deny-github.mjs");
  writeFileSync(
    denyGh,
    `import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(root, "compatibility-requests.jsonl"))}, JSON.stringify(args) + "\\n");
if (args.includes('view') && args.includes('closedByPullRequestsReferences')) { console.log(JSON.stringify({closedByPullRequestsReferences: []})); process.exit(0); }
if (args[0] !== 'api' || args.some(x => ['POST','PATCH','DELETE','PUT'].includes(x))) throw new Error('Write forbidden');
if (args[1] === 'repos/openclaw/clawsweeper/issues/123') console.log(JSON.stringify({ number: 123, title: 'Sample item', html_url: 'https://github.com/openclaw/clawsweeper/issues/123', state: 'open', body: '', user: {login: 'contributor'}, author_association: 'NONE', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', comments: 0, labels: [], locked: false }));
else if (args[1].split('?')[0].endsWith('/comments')) console.log('[]');
else throw new Error('Unexpected read: ' + args[1]);
`,
  );
  const apply = spawnSync(
    process.execPath,
    [
      "dist/clawsweeper.js",
      "apply-decisions",
      "--target-repo",
      "openclaw/clawsweeper",
      "--items-dir",
      itemsDir,
      "--closed-dir",
      join(stateRoot, "closed"),
      "--plans-dir",
      join(stateRoot, "plans"),
      "--report-path",
      join(stateRoot, "apply.json"),
      "--skip-dashboard",
      "--item-number",
      "123",
      "--dry-run",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, GH_BIN: process.execPath, GH_BIN_ARGS: JSON.stringify([denyGh]) },
      timeout: 30_000,
    },
  );
  writeFileSync(join(root, "stable-apply.log"), `${apply.stdout}\n${apply.stderr}`);
  assert.equal(apply.status, 0, apply.stderr);
  assert.equal(
    JSON.parse(readFileSync(join(stateRoot, "apply.json"), "utf8"))[0].action,
    "review_comment_synced",
  );
  // Apply sanitization upgrades existing records via the managed writer, whose
  // baseline must precede both report replacement and decision-packet sync.
  const prior = stableReport.replace('title: "Sample item"', `title: "Sample ${capability}"`);
  writeFileSync(reportPath, prior);
  const baseline = join(root, "baseline");
  const operations = createApplyRecordOperations({
    applyKind: "all",
    canonicalBaselineDir: baseline,
    closedDir: join(stateRoot, "closed"),
    decisionPacketsDir: packetsDir,
    dryRun: false,
    itemsDir,
    plansDir: join(stateRoot, "plans"),
    profile: repositoryProfileFor("openclaw/clawsweeper"),
    recordRoot: stateRoot,
    requestedItemNumberSet: new Set([123]),
    syncCommentsOnly: false,
    targetRepo: () => "openclaw/clawsweeper",
    reportEntriesForDir: () => [],
  });
  const safe = publicationSafeReport(prior);
  assert.notEqual(safe, prior);
  const upgrade = spawnSync(
    process.execPath,
    [
      "dist/clawsweeper.js",
      "apply-decisions",
      "--target-repo",
      "openclaw/clawsweeper",
      "--record-root",
      stateRoot,
      "--items-dir",
      itemsDir,
      "--closed-dir",
      join(stateRoot, "closed"),
      "--plans-dir",
      join(stateRoot, "plans"),
      "--decision-packets-dir",
      packetsDir,
      "--canonical-record-baseline-dir",
      baseline,
      "--report-path",
      join(stateRoot, "upgrade.json"),
      "--skip-dashboard",
      "--item-number",
      "123",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, GH_BIN: process.execPath, GH_BIN_ARGS: JSON.stringify([denyGh]) },
      timeout: 30_000,
    },
  );
  writeFileSync(join(root, "upgrade-apply.log"), `${upgrade.stdout}\n${upgrade.stderr}`);
  assert.equal(upgrade.status, 0, upgrade.stderr);
  assert.equal(
    JSON.parse(readFileSync(join(stateRoot, "upgrade.json"), "utf8"))[0].action,
    "kept_open",
  );
  const updated = readFileSync(reportPath, "utf8");
  assert.equal(readReviewRecord(updated).decision.decision, "keep_open");
  assert.match(updated, /^review_status: failed$/m);
  assert.equal(
    readFileSync(join(baseline, "records/openclaw-clawsweeper/items/123.md"), "utf8"),
    prior,
  );
  assert.equal(
    readFileSync(join(baseline, "records/openclaw-clawsweeper/decision-packets/123.json"), "utf8"),
    stablePacket,
  );
  assert.equal(
    JSON.parse(readFileSync(join(packetsDir, "123.json"), "utf8")).subject.title,
    "Sample [redacted credential]",
  );
  operations.writeReportMarkdown(reportPath, updated);
  assert.equal(
    readFileSync(join(baseline, "records/openclaw-clawsweeper/items/123.md"), "utf8"),
    prior,
  );
  proof.scenarios.compatibility = {
    reportSha256: hash(stableReport),
    packetSha256: hash(stablePacket),
    loaded: true,
    rendered: true,
    dryRunApply: "review_comment_synced",
    upgrade: "failed/keep_open",
    baselineReportUnchanged: true,
    baselinePacketUnchanged: true,
    syncedPacket: true,
  };
  writeFileSync(join(root, "proof.json"), JSON.stringify(proof, null, 2) + "\n");
  console.log(JSON.stringify(proof, null, 2));
} finally {
  process.env = originalEnv;
}
