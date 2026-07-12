import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { mockGhBinEnv } from "../helpers.ts";
import {
  buildStagedProofPlan,
  executeStagedProofPlan,
  stagedProofBundle,
  stagedProofPlanArtifact,
} from "../../dist/repair/staged-proof-gates.js";

const repoRoot = process.cwd();
const MERGE_HEAD_SHA = "a".repeat(40);
const MERGE_BASE_SHA = "c".repeat(40);

test("issue implementation post-flight waits for green PR checks without merging", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-post-flight-"));
  const fakeBin = path.join(tmp, "bin");
  const jobPath = path.join(tmp, "job.md");
  const runDir = path.join(tmp, "run");
  const resultPath = path.join(runDir, "result.json");
  const reportPath = path.join(runDir, "post-flight-report.json");

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(fakeBin, "gh"),
    [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/pulls/123') {",
      "  process.stdout.write(JSON.stringify({",
      "    number: 123,",
      "    state: 'open',",
      "    title: 'fix(ui): preserve source config',",
      "    draft: false,",
      "    labels: [],",
      "    base: { ref: 'main' },",
      "    merged_at: null,",
      "    head: { sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },",
      "  }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/issues/123/comments?per_page=100') {",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'pr' && args[1] === 'view') {",
      "  process.stdout.write(JSON.stringify({",
      "    baseRefName: 'main',",
      "    isDraft: false,",
      "    mergeable: 'MERGEABLE',",
      "    mergeStateStatus: 'CLEAN',",
      "    reviewDecision: null,",
      "    state: 'OPEN',",
      "    statusCheckRollup: [",
      "      {",
      "        name: 'Real behavior proof',",
      "        workflowName: 'Real behavior proof',",
      "        startedAt: '2026-05-24T00:39:28Z',",
      "        completedAt: '2026-05-24T00:40:30Z',",
      "        status: 'COMPLETED',",
      "        conclusion: 'CANCELLED',",
      "      },",
      "      {",
      "        name: 'Real behavior proof',",
      "        workflowName: 'Real behavior proof',",
      "        startedAt: '2026-05-24T00:39:44Z',",
      "        completedAt: '2026-05-24T00:39:56Z',",
      "        status: 'COMPLETED',",
      "        conclusion: 'SUCCESS',",
      "      },",
      "    ],",
      "    title: 'fix(ui): preserve source config',",
      "    url: 'https://github.com/openclaw/openclaw/pull/123',",
      "  }));",
      "  process.exit(0);",
      "}",
      "process.stderr.write(`unexpected gh args: ${args.join(' ')}\\n`);",
      "process.exit(1);",
    ].join("\n"),
    { mode: 0o755 },
  );

  fs.writeFileSync(
    jobPath,
    [
      "---",
      "repo: openclaw/openclaw",
      "cluster_id: issue-openclaw-openclaw-85831",
      "mode: autonomous",
      "allowed_actions:",
      "  - comment",
      "  - label",
      "  - fix",
      "  - raise_pr",
      "blocked_actions:",
      "  - close",
      "  - merge",
      "canonical:",
      "  - '#85831'",
      "candidates:",
      "  - '#85831'",
      "cluster_refs:",
      "  - '#85831'",
      "allow_fix_pr: true",
      "allow_merge: false",
      "security_policy: central_security_only",
      "security_sensitive: false",
      "target_branch: clawsweeper/issue-openclaw-openclaw-85831",
      "source: issue_implementation",
      "---",
      "Issue implementation job.",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    resultPath,
    JSON.stringify(
      {
        repo: "openclaw/openclaw",
        cluster_id: "issue-openclaw-openclaw-85831",
        mode: "autonomous",
        actions: [],
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(runDir, "fix-execution-report.json"),
    JSON.stringify(
      {
        actions: [
          {
            action: "open_fix_pr",
            status: "opened",
            pr_url: "https://github.com/openclaw/openclaw/pull/123",
            branch: "clawsweeper/issue-openclaw-openclaw-85831",
          },
        ],
      },
      null,
      2,
    ),
  );

  try {
    execFileSync(process.execPath, ["dist/repair/post-flight.js", jobPath, resultPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CLAWSWEEPER_ALLOW_EXECUTE: "1",
        CLAWSWEEPER_ALLOWED_OWNER: "openclaw",
        ...mockGhBinEnv(path.join(fakeBin, "gh"), fakeBin),
      },
      stdio: "pipe",
    });

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.deepEqual(report.actions, [
      {
        action: "finalize_fix_pr",
        source_action: "open_fix_pr",
        source_status: "opened",
        target: "https://github.com/openclaw/openclaw/pull/123",
        pr: "#123",
        title: "fix(ui): preserve source config",
        status: "ready",
        reason:
          "issue implementation PR checks are green; merge intentionally blocked for this lane",
        mergeable: "MERGEABLE",
        merge_state_status: "CLEAN",
        review_decision: null,
        waited_ms: 0,
      },
    ]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("issue implementation post-flight waits for checks to be created", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-post-flight-"));
  const fakeBin = path.join(tmp, "bin");
  const jobPath = path.join(tmp, "job.md");
  const runDir = path.join(tmp, "run");
  const resultPath = path.join(runDir, "result.json");
  const reportPath = path.join(runDir, "post-flight-report.json");
  const viewCountPath = path.join(tmp, "view-count.txt");

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(fakeBin, "gh"),
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/pulls/123') {",
      "  process.stdout.write(JSON.stringify({",
      "    number: 123, state: 'open', title: 'fix(ui): preserve source config',",
      "    draft: false, labels: [], base: { ref: 'main' }, merged_at: null,",
      "    head: { sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },",
      "  }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/issues/123/comments?per_page=100') {",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'pr' && args[1] === 'view') {",
      "  const path = process.env.FAKE_GH_VIEW_COUNT_FILE;",
      "  const count = fs.existsSync(path) ? Number(fs.readFileSync(path, 'utf8')) : 0;",
      "  fs.writeFileSync(path, String(count + 1));",
      "  const checks = count === 0",
      "    ? [{ name: 'label', workflowName: 'Labeler', startedAt: '2026-05-24T00:39:40Z', status: 'COMPLETED', conclusion: 'SUCCESS' }]",
      "    : [{ name: 'check', startedAt: '2026-05-24T00:39:44Z', status: 'COMPLETED', conclusion: 'SUCCESS' }];",
      "  process.stdout.write(JSON.stringify({",
      "    baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE',",
      "    mergeStateStatus: 'CLEAN', reviewDecision: null, state: 'OPEN',",
      "    statusCheckRollup: checks, title: 'fix(ui): preserve source config',",
      "    url: 'https://github.com/openclaw/openclaw/pull/123',",
      "  }));",
      "  process.exit(0);",
      "}",
      "process.stderr.write(`unexpected gh args: ${args.join(' ')}\\n`);",
      "process.exit(1);",
    ].join("\n"),
    { mode: 0o755 },
  );

  writeIssueImplementationJob(jobPath);
  writeIssueImplementationReports(runDir, resultPath);

  try {
    execFileSync(process.execPath, ["dist/repair/post-flight.js", jobPath, resultPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CLAWSWEEPER_ALLOW_EXECUTE: "1",
        CLAWSWEEPER_ALLOWED_OWNER: "openclaw",
        CLAWSWEEPER_POST_FLIGHT_WAIT_MS: "10000",
        CLAWSWEEPER_POST_FLIGHT_POLL_MS: "1",
        FAKE_GH_VIEW_COUNT_FILE: viewCountPath,
        ...mockGhBinEnv(path.join(fakeBin, "gh"), fakeBin),
      },
      stdio: "pipe",
    });

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.actions[0]?.status, "ready");
    assert.equal(fs.readFileSync(viewCountPath, "utf8"), "2");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("merge post-flight requires exact proof and server-enforced strict base binding", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-post-flight-"));
  const fakeBin = path.join(tmp, "bin");
  const jobPath = path.join(tmp, "job.md");
  const runDir = path.join(tmp, "run");
  const resultPath = path.join(runDir, "result.json");
  const reportPath = path.join(runDir, "post-flight-report.json");
  const mergeFlagPath = path.join(tmp, "merged.txt");
  const viewCountPath = path.join(tmp, "view-count.txt");
  const commentsCountPath = path.join(tmp, "comments-count.txt");

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(fakeBin, "gh"),
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/pulls/123') {",
      "  const merged = fs.existsSync(process.env.FAKE_GH_MERGED_FILE);",
      "  process.stdout.write(JSON.stringify({",
      "    number: 123, state: merged ? 'closed' : 'open', title: 'fix(ui): preserve source config',",
      `    draft: false, labels: [], base: { ref: 'main', sha: '${MERGE_BASE_SHA}' },`,
      "    merged_at: merged ? '2026-05-24T00:42:00Z' : null,",
      "    merge_commit_sha: merged ? 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' : null,",
      `    head: { sha: '${MERGE_HEAD_SHA}' },`,
      "  }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/issues/123/comments?per_page=100') {",
      "  const path = process.env.FAKE_GH_COMMENTS_COUNT_FILE;",
      "  const count = fs.existsSync(path) ? Number(fs.readFileSync(path, 'utf8')) : 0;",
      "  fs.writeFileSync(path, String(count + 1));",
      "  if (process.env.FAKE_GH_LATE_SECURITY === '1' && count >= 2) {",
      "    process.stdout.write('<!-- clawsweeper-security:security-sensitive item=123 sha=abc -->');",
      "  }",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/rules/branches/main') {",
      "  const rules = process.env.FAKE_GH_STRICT_BASE === '1'",
      "    ? [{ type: 'required_status_checks', ruleset_id: 18588237, ruleset_source: 'openclaw/openclaw', ruleset_source_type: 'Repository', parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: 'required-ci/exact-merge' }] } }]",
      "    : [];",
      "  process.stdout.write(JSON.stringify(rules));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/rulesets/18588237') {",
      "  process.stdout.write(JSON.stringify({ bypass_actors: [] }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/branches/main/protection') {",
      "  process.stdout.write(JSON.stringify({ required_status_checks: null }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'api' && args[1] === 'graphql') {",
      "  process.stdout.write(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'pr' && args[1] === 'view') {",
      "  const path = process.env.FAKE_GH_VIEW_COUNT_FILE;",
      "  const count = fs.existsSync(path) ? Number(fs.readFileSync(path, 'utf8')) : 0;",
      "  fs.writeFileSync(path, String(count + 1));",
      "  const checks = count === 0",
      "    ? [{ name: 'label', workflowName: 'Labeler', startedAt: '2026-05-24T00:39:40Z', status: 'COMPLETED', conclusion: 'SUCCESS' }]",
      "    : [{ name: 'check', workflowName: 'CI', startedAt: '2026-05-24T00:39:44Z', status: 'COMPLETED', conclusion: 'SUCCESS' }];",
      "  process.stdout.write(JSON.stringify({",
      "    baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE',",
      "    mergeStateStatus: 'CLEAN', reviewDecision: null, state: 'OPEN',",
      "    statusCheckRollup: checks, title: 'fix(ui): preserve source config',",
      "    url: 'https://github.com/openclaw/openclaw/pull/123',",
      "  }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'pr' && args[1] === 'merge') {",
      "  if (process.env.FAKE_GH_MERGE_RACE === '1') {",
      "    process.stderr.write('base branch was modified; review and try the merge again\\n');",
      "    process.exit(1);",
      "  }",
      "  fs.writeFileSync(process.env.FAKE_GH_MERGED_FILE, '1');",
      "  process.exit(0);",
      "}",
      "process.stderr.write(`unexpected gh args: ${args.join(' ')}\\n`);",
      "process.exit(1);",
    ].join("\n"),
    { mode: 0o755 },
  );

  writeMergeJob(jobPath);
  writeMergeReports(runDir, resultPath);

  try {
    const staleHead = "d".repeat(40);
    const fixReportPath = path.join(runDir, "fix-execution-report.json");
    const staleReport = JSON.parse(fs.readFileSync(fixReportPath, "utf8"));
    staleReport.actions[0].commit = staleHead;
    staleReport.actions[0].merge_preflight.validation_proof = passedValidationProof(
      staleHead,
      MERGE_BASE_SHA,
    );
    staleReport.actions[0].merge_preflight.validated_head_sha = staleHead;
    fs.writeFileSync(fixReportPath, JSON.stringify(staleReport, null, 2));
    const env = {
      ...process.env,
      CLAWSWEEPER_ALLOW_EXECUTE: "1",
      CLAWSWEEPER_ALLOWED_OWNER: "openclaw",
      CLAWSWEEPER_ALLOW_MERGE: "1",
      CLAWSWEEPER_APP_SLUG: "openclaw-clawsweeper",
      CLAWSWEEPER_AUTHENTICATED_APP_ID: "3306130",
      CLAWSWEEPER_AUTHENTICATED_APP_SLUG: "openclaw-clawsweeper",
      CLAWSWEEPER_AUTHENTICATED_INSTALLATION_ID: "987654",
      CLAWSWEEPER_RULESET_APP_ID: "3306130",
      CLAWSWEEPER_RULESET_APP_SLUG: "openclaw-clawsweeper",
      CLAWSWEEPER_RULESET_INSTALLATION_ID: "987654",
      CLAWSWEEPER_RULESET_GH_TOKEN: "ruleset-verifier",
      CLAWSWEEPER_POST_FLIGHT_REQUIRE_PR_CHECKS: "1",
      CLAWSWEEPER_POST_FLIGHT_WAIT_MS: "10000",
      CLAWSWEEPER_POST_FLIGHT_POLL_MS: "1",
      FAKE_GH_MERGED_FILE: mergeFlagPath,
      FAKE_GH_VIEW_COUNT_FILE: viewCountPath,
      FAKE_GH_COMMENTS_COUNT_FILE: commentsCountPath,
      ...mockGhBinEnv(path.join(fakeBin, "gh"), fakeBin),
    };
    writeMergeReports(runDir, resultPath);
    fs.writeFileSync(mergeFlagPath, "1");
    const alreadyMergedPath = path.join(runDir, "fix-execution-report.json");
    const alreadyMergedReport = JSON.parse(fs.readFileSync(alreadyMergedPath, "utf8"));
    alreadyMergedReport.actions[0].commit = "d".repeat(40);
    fs.writeFileSync(alreadyMergedPath, JSON.stringify(alreadyMergedReport, null, 2));
    runPostFlight(jobPath, resultPath, env, 1);
    const alreadyMerged = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(alreadyMerged.actions[0]?.status, "blocked");
    assert.equal(
      alreadyMerged.actions[0]?.reason,
      "merged pull request head does not match the authorized repair commit",
    );
    fs.rmSync(mergeFlagPath, { force: true });
    fs.rmSync(reportPath, { force: true });
    fs.rmSync(viewCountPath, { force: true });
    const staleAfterMerged = JSON.parse(fs.readFileSync(fixReportPath, "utf8"));
    staleAfterMerged.actions[0].commit = staleHead;
    staleAfterMerged.actions[0].merge_preflight.validation_proof = passedValidationProof(
      staleHead,
      MERGE_BASE_SHA,
    );
    staleAfterMerged.actions[0].merge_preflight.validated_head_sha = staleHead;
    fs.writeFileSync(fixReportPath, JSON.stringify(staleAfterMerged, null, 2));

    runPostFlight(jobPath, resultPath, env, 1);
    const stalePostFlight = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(stalePostFlight.actions[0]?.status, "blocked");
    assert.equal(
      stalePostFlight.actions[0]?.reason,
      "staged validation proof does not match the live pull request head",
    );
    assert.equal(fs.existsSync(mergeFlagPath), false);

    writeMergeReports(runDir, resultPath);
    const staleBase = "e".repeat(40);
    const staleBaseReport = JSON.parse(fs.readFileSync(fixReportPath, "utf8"));
    staleBaseReport.actions[0].merge_preflight.validation_proof = passedValidationProof(
      MERGE_HEAD_SHA,
      staleBase,
    );
    staleBaseReport.actions[0].merge_preflight.validated_base_sha = staleBase;
    fs.writeFileSync(fixReportPath, JSON.stringify(staleBaseReport, null, 2));
    fs.rmSync(reportPath, { force: true });
    fs.rmSync(viewCountPath, { force: true });
    runPostFlight(jobPath, resultPath, env, 1);
    const staleBasePostFlight = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(staleBasePostFlight.actions[0]?.status, "blocked");
    assert.equal(
      staleBasePostFlight.actions[0]?.reason,
      "staged validation proof does not match the live pull request base",
    );
    assert.equal(fs.existsSync(mergeFlagPath), false);

    writeMergeReports(runDir, resultPath);
    fs.rmSync(reportPath, { force: true });
    fs.rmSync(viewCountPath, { force: true });
    runPostFlight(jobPath, resultPath, env, 1);
    const unboundReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(unboundReport.actions[0]?.status, "blocked");
    assert.equal(
      unboundReport.actions[0]?.reason,
      "automerge disabled: main lacks server-enforced strict base binding",
    );
    assert.equal(fs.existsSync(mergeFlagPath), false);

    writeMergeReports(runDir, resultPath);
    fs.rmSync(reportPath, { force: true });
    fs.rmSync(viewCountPath, { force: true });
    fs.rmSync(commentsCountPath, { force: true });
    runPostFlight(
      jobPath,
      resultPath,
      { ...env, FAKE_GH_STRICT_BASE: "1", FAKE_GH_LATE_SECURITY: "1" },
      1,
    );
    const lateSecurityReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(lateSecurityReport.actions[0]?.status, "blocked");
    assert.equal(
      lateSecurityReport.actions[0]?.reason,
      "security-sensitive target requires central security triage",
    );
    assert.equal(fs.existsSync(mergeFlagPath), false);

    writeMergeReports(runDir, resultPath);
    fs.rmSync(reportPath, { force: true });
    fs.rmSync(viewCountPath, { force: true });
    fs.rmSync(commentsCountPath, { force: true });
    runPostFlight(
      jobPath,
      resultPath,
      { ...env, FAKE_GH_STRICT_BASE: "1", FAKE_GH_MERGE_RACE: "1" },
      1,
    );
    const mergeRaceReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(mergeRaceReport.outcome, "requeue");
    assert.equal(mergeRaceReport.actions[0]?.status, "blocked");
    assert.equal(mergeRaceReport.actions[0]?.retry_recommended, true);
    assert.match(mergeRaceReport.actions[0]?.reason, /merge attempt needs branch refresh/);
    assert.equal(fs.existsSync(mergeFlagPath), false);

    writeMergeReports(runDir, resultPath);
    fs.rmSync(reportPath, { force: true });
    fs.rmSync(viewCountPath, { force: true });
    fs.rmSync(commentsCountPath, { force: true });
    execFileSync(process.execPath, ["dist/repair/post-flight.js", jobPath, resultPath], {
      cwd: repoRoot,
      env: { ...env, FAKE_GH_STRICT_BASE: "1" },
      stdio: "pipe",
    });
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.actions[0]?.status, "executed");
    assert.equal(report.actions[0]?.merge_commit_sha, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    assert.equal(fs.readFileSync(viewCountPath, "utf8"), "2");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("post-flight rechecks live security immediately before privileged mutations", () => {
  const source = fs.readFileSync("src/repair/post-flight.ts", "utf8");
  const finalizeFixPr = source.slice(
    source.indexOf("function finalizeFixPr"),
    source.indexOf("function publishedFixAction"),
  );
  assert.match(
    finalizeFixPr,
    /liveSecurityBlockReason\([\s\S]*fetchPullRequest[\s\S]*\n\s*try \{\n\s*ghWithRetry\(mergeArgs\)/,
  );

  const closeout = source.slice(
    source.indexOf("function finalizePostMergeCloseout"),
    source.indexOf("function validateMergePolicy"),
  );
  assert.ok(
    [...closeout.matchAll(/SecurityBlock = (?:freshL|l)iveSecurityBlockReason/g)].length >= 3,
  );
  assert.ok(
    closeout.indexOf("beforeCommentSecurityBlock") < closeout.indexOf('"issue",\n    "comment"'),
  );
  assert.ok(closeout.indexOf("beforeCloseSecurityBlock") < closeout.indexOf('["pr", "close"'));
});

test("post-flight keeps no-timestamp pending duplicate checks visible", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-post-flight-"));
  const fakeBin = path.join(tmp, "bin");
  const jobPath = path.join(tmp, "job.md");
  const runDir = path.join(tmp, "run");
  const resultPath = path.join(runDir, "result.json");
  const reportPath = path.join(runDir, "post-flight-report.json");
  const viewCountPath = path.join(tmp, "view-count.txt");

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(fakeBin, "gh"),
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/pulls/123') {",
      "  process.stdout.write(JSON.stringify({",
      "    number: 123, state: 'open', title: 'fix(ui): preserve source config',",
      "    draft: false, labels: [], base: { ref: 'main' }, merged_at: null,",
      "    head: { sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },",
      "  }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/issues/123/comments?per_page=100') {",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'pr' && args[1] === 'view') {",
      "  const path = process.env.FAKE_GH_VIEW_COUNT_FILE;",
      "  const count = fs.existsSync(path) ? Number(fs.readFileSync(path, 'utf8')) : 0;",
      "  fs.writeFileSync(path, String(count + 1));",
      "  const checks = count === 0",
      "    ? [",
      "        { name: 'check', workflowName: 'CI', startedAt: '2026-05-24T00:39:40Z', status: 'COMPLETED', conclusion: 'SUCCESS' },",
      "        { name: 'check', workflowName: 'CI', status: 'QUEUED', conclusion: null },",
      "      ]",
      "    : [{ name: 'check', workflowName: 'CI', startedAt: '2026-05-24T00:39:44Z', status: 'COMPLETED', conclusion: 'SUCCESS' }];",
      "  process.stdout.write(JSON.stringify({",
      "    baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE',",
      "    mergeStateStatus: 'CLEAN', reviewDecision: null, state: 'OPEN',",
      "    statusCheckRollup: checks, title: 'fix(ui): preserve source config',",
      "    url: 'https://github.com/openclaw/openclaw/pull/123',",
      "  }));",
      "  process.exit(0);",
      "}",
      "process.stderr.write(`unexpected gh args: ${args.join(' ')}\\n`);",
      "process.exit(1);",
    ].join("\n"),
    { mode: 0o755 },
  );

  writeIssueImplementationJob(jobPath);
  writeIssueImplementationReports(runDir, resultPath);

  try {
    execFileSync(process.execPath, ["dist/repair/post-flight.js", jobPath, resultPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CLAWSWEEPER_ALLOW_EXECUTE: "1",
        CLAWSWEEPER_ALLOWED_OWNER: "openclaw",
        CLAWSWEEPER_POST_FLIGHT_WAIT_MS: "10000",
        CLAWSWEEPER_POST_FLIGHT_POLL_MS: "1",
        FAKE_GH_VIEW_COUNT_FILE: viewCountPath,
        ...mockGhBinEnv(path.join(fakeBin, "gh"), fakeBin),
      },
      stdio: "pipe",
    });

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.actions[0]?.status, "ready");
    assert.equal(fs.readFileSync(viewCountPath, "utf8"), "2");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

for (const checkState of ["missing", "pending"] as const) {
  test(`issue implementation post-flight requeues deadline-expired ${checkState} checks`, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-post-flight-"));
    const fakeBin = path.join(tmp, "bin");
    const jobPath = path.join(tmp, "job.md");
    const runDir = path.join(tmp, "run");
    const resultPath = path.join(runDir, "result.json");
    const reportPath = path.join(runDir, "post-flight-report.json");

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "gh"),
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/pulls/123') {",
        "  process.stdout.write(JSON.stringify({",
        "    number: 123, state: 'open', title: 'fix(ui): preserve source config',",
        "    draft: false, labels: [], base: { ref: 'main' }, merged_at: null,",
        "    head: { sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },",
        "  }));",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/issues/123/comments?per_page=100') {",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'pr' && args[1] === 'view') {",
        `  const checks = ${
          checkState === "missing"
            ? "[]"
            : "[{ name: 'check', workflowName: 'CI', status: 'QUEUED', conclusion: null }]"
        };`,
        "  process.stdout.write(JSON.stringify({",
        "    baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE',",
        "    mergeStateStatus: 'UNSTABLE', reviewDecision: null, state: 'OPEN',",
        "    statusCheckRollup: checks, title: 'fix(ui): preserve source config',",
        "    url: 'https://github.com/openclaw/openclaw/pull/123',",
        "  }));",
        "  process.exit(0);",
        "}",
        "process.stderr.write(`unexpected gh args: ${args.join(' ')}\\n`);",
        "process.exit(1);",
      ].join("\n"),
      { mode: 0o755 },
    );

    writeIssueImplementationJob(jobPath);
    writeIssueImplementationReports(runDir, resultPath);

    try {
      runPostFlight(
        jobPath,
        resultPath,
        {
          ...process.env,
          CLAWSWEEPER_ALLOW_EXECUTE: "1",
          CLAWSWEEPER_ALLOWED_OWNER: "openclaw",
          CLAWSWEEPER_POST_FLIGHT_WAIT_MS: "0",
          CLAWSWEEPER_POST_FLIGHT_POLL_MS: "0",
          ...mockGhBinEnv(path.join(fakeBin, "gh"), fakeBin),
        },
        1,
      );

      const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      assert.equal(report.outcome, "requeue");
      assert.equal(report.actions[0]?.status, "blocked");
      assert.equal(report.actions[0]?.retry_recommended, true);
      assert.match(
        report.actions[0]?.reason,
        checkState === "missing" ? /no PR checks found/i : /checks are not clean/i,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}

test("issue implementation post-flight checks the publication receipt head before readiness", () => {
  const source = fs.readFileSync("src/repair/post-flight.ts", "utf8");
  const issueFinalizer = source.slice(
    source.indexOf("function finalizeIssueImplementationPr"),
    source.indexOf("function finalizePostMergeCloseouts"),
  );
  assert.match(
    source,
    /expectedPublishedHeadSha:\s*publicationReceipt\?\.published_head_sha\s*\?\?\s*null/,
  );
  assert.ok(
    issueFinalizer.indexOf("issueImplementationPublishedHeadBlock") <
      issueFinalizer.indexOf('status: "ready"'),
  );
});

test("post-flight exports a blocked report before exiting unsuccessfully", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-post-flight-"));
  const jobPath = path.join(tmp, "job.md");
  const runDir = path.join(tmp, "run");
  const resultPath = path.join(runDir, "result.json");
  const reportPath = path.join(runDir, "post-flight-report.json");
  const outputPath = path.join(tmp, "github-output.txt");

  fs.mkdirSync(runDir, { recursive: true });
  writeIssueImplementationJob(jobPath);
  fs.writeFileSync(
    resultPath,
    JSON.stringify(
      {
        repo: "openclaw/openclaw",
        cluster_id: "issue-openclaw-openclaw-85831",
        mode: "autonomous",
        actions: [],
      },
      null,
      2,
    ),
  );

  try {
    runPostFlight(
      jobPath,
      resultPath,
      {
        ...process.env,
        CLAWSWEEPER_ALLOW_EXECUTE: "1",
        CLAWSWEEPER_ALLOWED_OWNER: "openclaw",
        GITHUB_OUTPUT: outputPath,
      },
      1,
    );

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.outcome, "blocked");
    assert.match(report.detail, /no fix-execution-report/);
    assert.match(fs.readFileSync(outputPath, "utf8"), /^report_outcome=blocked$/m);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function runPostFlight(
  jobPath: string,
  resultPath: string,
  env: NodeJS.ProcessEnv,
  expectedStatus: number,
) {
  const child = spawnSync(process.execPath, ["dist/repair/post-flight.js", jobPath, resultPath], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    stdio: "pipe",
  });
  assert.equal(child.status, expectedStatus, child.stderr || child.stdout);
  return child;
}

function writeIssueImplementationJob(jobPath: string) {
  fs.writeFileSync(
    jobPath,
    [
      "---",
      "repo: openclaw/openclaw",
      "cluster_id: issue-openclaw-openclaw-85831",
      "mode: autonomous",
      "allowed_actions:",
      "  - comment",
      "  - label",
      "  - fix",
      "  - raise_pr",
      "blocked_actions:",
      "  - close",
      "  - merge",
      "canonical:",
      "  - '#85831'",
      "candidates:",
      "  - '#85831'",
      "cluster_refs:",
      "  - '#85831'",
      "allow_fix_pr: true",
      "allow_merge: false",
      "security_policy: central_security_only",
      "security_sensitive: false",
      "target_branch: clawsweeper/issue-openclaw-openclaw-85831",
      "source: issue_implementation",
      "---",
      "Issue implementation job.",
      "",
    ].join("\n"),
  );
}

function writeMergeJob(jobPath: string) {
  fs.writeFileSync(
    jobPath,
    [
      "---",
      "repo: openclaw/openclaw",
      "cluster_id: automerge-openclaw-openclaw-123",
      "mode: autonomous",
      "allowed_actions:",
      "  - comment",
      "  - label",
      "  - fix",
      "  - raise_pr",
      "  - merge",
      "blocked_actions: []",
      "canonical:",
      "  - '#123'",
      "candidates:",
      "  - '#123'",
      "cluster_refs:",
      "  - '#123'",
      "allow_fix_pr: true",
      "allow_merge: true",
      "security_policy: central_security_only",
      "security_sensitive: false",
      "target_branch: clawsweeper/automerge-openclaw-openclaw-123",
      "source: pr_automerge",
      "---",
      "Automerge job.",
      "",
    ].join("\n"),
  );
}

function writeIssueImplementationReports(runDir: string, resultPath: string) {
  fs.writeFileSync(
    resultPath,
    JSON.stringify(
      {
        repo: "openclaw/openclaw",
        cluster_id: "issue-openclaw-openclaw-85831",
        mode: "autonomous",
        actions: [],
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(runDir, "fix-execution-report.json"),
    JSON.stringify(
      {
        actions: [
          {
            action: "open_fix_pr",
            status: "opened",
            pr_url: "https://github.com/openclaw/openclaw/pull/123",
            branch: "clawsweeper/issue-openclaw-openclaw-85831",
          },
        ],
      },
      null,
      2,
    ),
  );
}

function writeMergeReports(runDir: string, resultPath: string) {
  const proof = passedValidationProofFixture(MERGE_HEAD_SHA, MERGE_BASE_SHA);
  fs.writeFileSync(
    resultPath,
    JSON.stringify(
      {
        repo: "openclaw/openclaw",
        cluster_id: "automerge-openclaw-openclaw-123",
        mode: "autonomous",
        actions: [],
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(runDir, "fix-execution-report.json"),
    JSON.stringify(
      {
        validation_proof_plan: proof.plan,
        actions: [
          {
            action: "open_fix_pr",
            status: "opened",
            pr_url: "https://github.com/openclaw/openclaw/pull/123",
            branch: "clawsweeper/automerge-openclaw-openclaw-123",
            commit: MERGE_HEAD_SHA,
            merge_preflight: {
              security_status: "cleared",
              security_evidence: ["no security signal"],
              comments_status: "resolved",
              comments_evidence: ["no unresolved review comments"],
              bot_comments_status: "resolved",
              bot_comments_evidence: ["no unresolved bot comments"],
              validation_commands: ["pnpm test"],
              validation_proof: proof.bundle,
              validated_head_sha: MERGE_HEAD_SHA,
              validated_base_sha: MERGE_BASE_SHA,
              codex_review: {
                command: "/review",
                status: "passed",
                findings_addressed: true,
                evidence: ["Codex review passed"],
              },
            },
          },
        ],
      },
      null,
      2,
    ),
  );
}

function passedValidationProof(headSha: string, baseSha: string) {
  return passedValidationProofFixture(headSha, baseSha).bundle;
}

function passedValidationProofFixture(headSha: string, baseSha: string) {
  const plan = buildStagedProofPlan({
    commands: [
      {
        parts: ["git", "diff", "--check"],
        source: "configured",
        canonical: false,
        required: true,
        originalIndex: 0,
      },
    ],
    changedFiles: ["src/example.ts"],
  });
  const trace = executeStagedProofPlan(plan, {
    commandTimeoutMs: 1000,
    budgetMs: 1000,
    validatedHeadSha: headSha,
    validatedBaseSha: baseSha,
    nowMs: () => 10,
    runCommand: () => ({ executedCommands: ["git diff --check"], reason: "passed" }),
  }).trace;
  return {
    plan: stagedProofPlanArtifact(plan),
    bundle: stagedProofBundle([trace]),
  };
}
