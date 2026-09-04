import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { mockGhBinEnv } from "../helpers.ts";

const repoRoot = process.cwd();

test("post-flight status policy keeps duplicate and ignored-check decisions across the shared rollup", () => {
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
      "        name: 'label',",
      "        workflowName: 'Labeler',",
      "        startedAt: '2026-05-24T00:39:20Z',",
      "        completedAt: '2026-05-24T00:39:25Z',",
      "        status: 'COMPLETED',",
      "        conclusion: 'CANCELLED',",
      "      },",
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

test("merge post-flight waits when only ignored checks exist", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-post-flight-"));
  const fakeBin = path.join(tmp, "bin");
  const jobPath = path.join(tmp, "job.md");
  const runDir = path.join(tmp, "run");
  const resultPath = path.join(runDir, "result.json");
  const reportPath = path.join(runDir, "post-flight-report.json");
  const mergeFlagPath = path.join(tmp, "merged.txt");
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
      "  const merged = fs.existsSync(process.env.FAKE_GH_MERGED_FILE);",
      "  process.stdout.write(JSON.stringify({",
      "    number: 123, state: merged ? 'closed' : 'open', title: 'fix(ui): preserve source config',",
      "    draft: false, labels: [{ name: 'clawsweeper:automerge' }], base: { ref: 'main' },",
      "    merged_at: merged ? '2026-05-24T00:42:00Z' : null,",
      "    merge_commit_sha: merged ? 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' : null,",
      "    head: { sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },",
      "  }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/issues/123/comments?per_page=100') {",
      "  process.stdout.write('');",
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
    execFileSync(process.execPath, ["dist/repair/post-flight.js", jobPath, resultPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CLAWSWEEPER_ALLOW_EXECUTE: "1",
        CLAWSWEEPER_ALLOWED_OWNER: "openclaw",
        CLAWSWEEPER_ALLOW_MERGE: "1",
        CLAWSWEEPER_POST_FLIGHT_REQUIRE_PR_CHECKS: "1",
        CLAWSWEEPER_POST_FLIGHT_WAIT_MS: "10000",
        CLAWSWEEPER_POST_FLIGHT_POLL_MS: "1",
        FAKE_GH_MERGED_FILE: mergeFlagPath,
        FAKE_GH_VIEW_COUNT_FILE: viewCountPath,
        ...mockGhBinEnv(path.join(fakeBin, "gh"), fakeBin),
      },
      stdio: "pipe",
    });

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.actions[0]?.status, "executed");
    assert.equal(report.actions[0]?.merge_commit_sha, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    assert.deepEqual(report.closure_authorization, {
      version: 1,
      status: "authorized",
      merged_fixes: [
        {
          fix_ref: "#123",
          merge_commit_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
      ],
    });
    assert.equal(fs.readFileSync(viewCountPath, "utf8"), "2");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("post-flight rechecks repair mode and live authorization immediately before merge", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-post-flight-gates-"));
  const fakeBin = path.join(temporary, "bin");
  const jobPath = path.join(temporary, "automerge-openclaw-openclaw-123.md");
  const runDir = path.join(temporary, "run");
  const resultPath = path.join(runDir, "result.json");
  const reportPath = path.join(runDir, "post-flight-report.json");
  const pullCountPath = path.join(temporary, "pull-count");
  const sourceCountPath = path.join(temporary, "source-pull-count");
  const mergedPath = path.join(temporary, "merged");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(fakeBin, "gh"),
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'api' && /^repos\\/openclaw\\/openclaw\\/pulls\\/(123|456)$/.test(args[1])) {",
      "  const number = Number(args[1].split('/').at(-1));",
      "  const source = process.env.FAKE_GH_REPLACEMENT === '1' && number === 123;",
      "  const countPath = source ? process.env.FAKE_GH_SOURCE_COUNT : process.env.FAKE_GH_PULL_COUNT;",
      "  const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, 'utf8')) : 0;",
      "  fs.writeFileSync(countPath, String(count + 1));",
      "  const sequences = JSON.parse(source ? process.env.FAKE_GH_SOURCE_LABEL_SEQUENCES : process.env.FAKE_GH_LABEL_SEQUENCES);",
      "  const labels = sequences[Math.min(count, sequences.length - 1)].map(name => ({name}));",
      "  const merged = !source && fs.existsSync(process.env.FAKE_GH_MERGED_FILE);",
      "  process.stdout.write(JSON.stringify({number,state:merged?'closed':'open',title:'fix: safe merge',draft:false,labels,base:{ref:'main'},merged_at:merged?'2026-07-31T00:00:00Z':null,merge_commit_sha:merged?'b'.repeat(40):null,head:{sha:'a'.repeat(40)}}));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'api' && args[1].includes('/comments?')) process.exit(0);",
      "if (args[0] === 'api' && args[1] === 'graphql') {",
      "  process.stdout.write(JSON.stringify({data:{repository:{pullRequest:{reviewThreads:{pageInfo:{hasNextPage:false},nodes:[]}}}}}));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'pr' && args[1] === 'view') {",
      "  process.stdout.write(JSON.stringify({baseRefName:'main',isDraft:false,mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',reviewDecision:null,state:'OPEN',statusCheckRollup:[{name:'CI',workflowName:'CI',startedAt:'2026-07-31T00:00:00Z',completedAt:'2026-07-31T00:01:00Z',status:'COMPLETED',conclusion:'SUCCESS'}],title:'fix: safe merge',url:`https://github.com/openclaw/openclaw/pull/${process.env.FAKE_GH_TARGET_NUMBER}`}));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'pr' && args[1] === 'merge') {fs.writeFileSync(process.env.FAKE_GH_MERGED_FILE,'1');process.exit(0)}",
      "process.stderr.write(`unexpected gh args: ${args.join(' ')}\\n`);process.exit(2);",
    ].join("\n"),
    { mode: 0o755 },
  );

  const execute = ({
    mode,
    sequences,
    sourceSequences,
    sourceUrls,
    plannedStrategy = "replace_uneditable_branch",
    executedFallback = false,
    canonicalNumber = 123,
  }: {
    mode: "autofix" | "automerge";
    sequences: string[][];
    sourceSequences?: string[][];
    sourceUrls?: string[];
    plannedStrategy?: "replace_uneditable_branch" | "repair_contributor_branch";
    executedFallback?: boolean;
    canonicalNumber?: number;
  }) => {
    fs.rmSync(mergedPath, { force: true });
    fs.rmSync(pullCountPath, { force: true });
    fs.rmSync(sourceCountPath, { force: true });
    writeMergeJob(jobPath);
    if (canonicalNumber !== 123) {
      fs.writeFileSync(
        jobPath,
        fs
          .readFileSync(jobPath, "utf8")
          .replace("canonical:\n  - '#123'", `canonical:\n  - '#${canonicalNumber}'`),
      );
    }
    if (mode === "autofix") {
      fs.writeFileSync(
        jobPath,
        fs.readFileSync(jobPath, "utf8").replace("repair_mode: automerge", "repair_mode: autofix"),
      );
    }
    writeMergeReports(runDir, resultPath);
    if (sourceSequences) {
      const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
      result.fix_artifact = {
        repair_strategy: plannedStrategy,
        source_prs: sourceUrls ?? ["https://github.com/openclaw/openclaw/pull/123"],
      };
      fs.writeFileSync(resultPath, JSON.stringify(result));
      const fixReportPath = path.join(runDir, "fix-execution-report.json");
      const fixReport = JSON.parse(fs.readFileSync(fixReportPath, "utf8"));
      fixReport.actions[0].pr_url = "https://github.com/openclaw/openclaw/pull/456";
      if (executedFallback) {
        fixReport.actions[0].repair_strategy = "replace_uneditable_branch";
        fixReport.actions[0].fallback_source_pr = "https://github.com/openclaw/openclaw/pull/123";
      }
      fs.writeFileSync(fixReportPath, JSON.stringify(fixReport));
    }
    execFileSync(process.execPath, ["dist/repair/post-flight.js", jobPath, resultPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CLAWSWEEPER_ALLOW_EXECUTE: "1",
        CLAWSWEEPER_ALLOW_MERGE: "1",
        CLAWSWEEPER_ALLOWED_OWNER: "openclaw",
        FAKE_GH_PULL_COUNT: pullCountPath,
        FAKE_GH_SOURCE_COUNT: sourceCountPath,
        FAKE_GH_MERGED_FILE: mergedPath,
        FAKE_GH_LABEL_SEQUENCES: JSON.stringify(sequences),
        FAKE_GH_SOURCE_LABEL_SEQUENCES: JSON.stringify(sourceSequences ?? []),
        FAKE_GH_REPLACEMENT: sourceSequences ? "1" : "0",
        FAKE_GH_TARGET_NUMBER: sourceSequences ? "456" : "123",
        ...mockGhBinEnv(path.join(fakeBin, "gh"), fakeBin),
      },
      stdio: "pipe",
    });
    return JSON.parse(fs.readFileSync(reportPath, "utf8"));
  };

  try {
    const autofix = execute({ mode: "autofix", sequences: [["clawsweeper:automerge"]] });
    assert.equal(autofix.actions[0]?.status, "blocked");
    assert.match(autofix.actions[0]?.reason, /autofix-only/);
    assert.equal(fs.existsSync(mergedPath), false);

    for (const label of [
      "ClawSweeper:Human-Review",
      "clawsweeper:autofix",
      "clawsweeper:autogenerated",
      "Security",
      "clawsweeper:needs-maintainer-review",
      "clawsweeper:needs-product-decision",
    ]) {
      const paused = execute({
        mode: "automerge",
        sequences: [["clawsweeper:automerge"], ["clawsweeper:automerge", label]],
      });
      assert.equal(paused.actions[0]?.status, "blocked", label);
      assert.match(paused.actions[0]?.reason, /protected or paused repair label/, label);
      assert.equal(fs.existsSync(mergedPath), false, label);
      assert.equal(fs.readFileSync(pullCountPath, "utf8"), "2", label);
    }

    const revoked = execute({ mode: "automerge", sequences: [["clawsweeper:automerge"], []] });
    assert.equal(revoked.actions[0]?.status, "blocked");
    assert.match(revoked.actions[0]?.reason, /explicit clawsweeper:automerge label/);
    assert.equal(fs.existsSync(mergedPath), false);

    for (const sourceLabels of [
      [],
      ["clawsweeper:automerge", "ClawSweeper:Human-Review"],
      ["clawsweeper:automerge", "clawsweeper:needs-security-review"],
    ]) {
      const revokedSource = execute({
        mode: "automerge",
        sequences: [["clawsweeper:automerge"]],
        sourceSequences: [["clawsweeper:automerge"], sourceLabels],
      });
      assert.equal(revokedSource.actions[0]?.status, "blocked", sourceLabels.join(","));
      assert.match(revokedSource.actions[0]?.reason, /fresh current-head ClawSweeper review/);
      assert.equal(fs.existsSync(mergedPath), false);
      assert.equal(fs.existsSync(sourceCountPath), false);
    }

    const unrelatedSource = execute({
      mode: "automerge",
      sequences: [["clawsweeper:automerge"]],
      sourceSequences: [["clawsweeper:automerge"]],
      sourceUrls: ["https://github.com/openclaw/openclaw/pull/789"],
    });
    assert.equal(unrelatedSource.actions[0]?.status, "blocked");
    assert.match(unrelatedSource.actions[0]?.reason, /fresh current-head ClawSweeper review/);
    assert.equal(fs.existsSync(mergedPath), false);

    const substitutedCanonical = execute({
      mode: "automerge",
      sequences: [["clawsweeper:automerge"]],
      sourceSequences: [["clawsweeper:automerge"]],
      sourceUrls: ["https://github.com/openclaw/openclaw/pull/789"],
      canonicalNumber: 789,
    });
    assert.equal(substitutedCanonical.actions[0]?.status, "blocked");
    assert.match(
      substitutedCanonical.actions[0]?.reason,
      /does not match its adopted pull request/,
    );
    assert.equal(fs.existsSync(mergedPath), false);

    const fallbackRevoked = execute({
      mode: "automerge",
      sequences: [["clawsweeper:automerge"]],
      sourceSequences: [["clawsweeper:automerge"], []],
      plannedStrategy: "repair_contributor_branch",
      executedFallback: true,
    });
    assert.equal(fallbackRevoked.actions[0]?.status, "blocked");
    assert.match(fallbackRevoked.actions[0]?.reason, /fresh current-head ClawSweeper review/);
    assert.equal(fs.existsSync(mergedPath), false);

    const authorizedReplacement = execute({
      mode: "automerge",
      sequences: [["clawsweeper:automerge"]],
      sourceSequences: [["clawsweeper:automerge"]],
    });
    assert.equal(authorizedReplacement.actions[0]?.status, "blocked");
    assert.match(authorizedReplacement.actions[0]?.reason, /fresh current-head ClawSweeper review/);
    assert.equal(fs.existsSync(mergedPath), false);

    const authorizedFallback = execute({
      mode: "automerge",
      sequences: [["clawsweeper:automerge"]],
      sourceSequences: [["clawsweeper:automerge"]],
      plannedStrategy: "repair_contributor_branch",
      executedFallback: true,
    });
    assert.equal(authorizedFallback.actions[0]?.status, "blocked");
    assert.match(authorizedFallback.actions[0]?.reason, /fresh current-head ClawSweeper review/);
    assert.equal(fs.existsSync(mergedPath), false);

    const authorized = execute({ mode: "automerge", sequences: [["clawsweeper:automerge"]] });
    assert.equal(authorized.actions[0]?.status, "executed");
    assert.equal(fs.existsSync(mergedPath), true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("post-flight records authorization and never closes related items directly", () => {
  const source = fs.readFileSync("src/repair/post-flight.ts", "utf8");

  assert.match(source, /from "\.\/merge-readiness-github\.js"/);
  assert.doesNotMatch(source, /function (?:fetchPullRequestView|validateResolvedReviewThreads)\(/);
  assert.match(source, /closure_authorization = buildClosureAuthorization/);
  assert.doesNotMatch(source, /finalizePostMergeCloseout/);
  assert.doesNotMatch(source, /postMergeCloseoutComment/);
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
      "repair_mode: automerge",
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
        actions: [
          {
            action: "open_fix_pr",
            status: "opened",
            pr_url: "https://github.com/openclaw/openclaw/pull/123",
            branch: "clawsweeper/automerge-openclaw-openclaw-123",
            merge_preflight: {
              security_status: "cleared",
              security_evidence: ["no security signal"],
              comments_status: "resolved",
              comments_evidence: ["no unresolved review comments"],
              bot_comments_status: "resolved",
              bot_comments_evidence: ["no unresolved bot comments"],
              validation_commands: ["pnpm test"],
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
