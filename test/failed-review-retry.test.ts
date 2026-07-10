import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  enforceExpectedIssueSourceRevisionForTest,
  failedReviewRetryEligibilityForTest,
  itemSourceRevisionSha256ForTest,
  isInfrastructureFailedReviewForTest,
  preserveFailedReviewRetryMetadataForTest,
} from "../dist/clawsweeper.js";
import { tmpPrefix, withMockGh, workPlanCandidateReport } from "./helpers.ts";

function failedReviewReport(overrides = {}) {
  return `${workPlanCandidateReport({
    repository: "openclaw/openclaw",
    number: 4242,
    type: "pull_request",
    review_status: "failed",
    pull_head_sha: "abc123def456",
    item_source_revision: "issue-source-revision",
    decision: "keep_open",
    confidence: "low",
    action_taken: "kept_open",
    work_candidate: "none",
    ...overrides,
  })}

## Summary

Codex review failed: timeout.

## Evidence

- **failure reason:** timeout
- **codex failure detail:** Codex worker timed out after 600000ms with ETIMEDOUT.
`;
}

function failedIssueRetryFixture(root: string, number: number) {
  const itemsDir = join(root, "items");
  const reportPath = join(root, "failed-review-retry-report.json");
  const itemPath = join(itemsDir, `${number}.md`);
  const statePath = join(root, "failed-review-retry-state", `${number}.json`);
  const issue = {
    number,
    title: "Failed issue review retry sample",
    body: "Issue body",
    html_url: `https://github.com/openclaw/openclaw/issues/${number}`,
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T01:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "contributor" },
    labels: [],
    comments: 0,
    pull_request: null,
  };
  const sourceRevision = itemSourceRevisionSha256ForTest(issue, []);
  mkdirSync(itemsDir, { recursive: true });
  writeFileSync(
    itemPath,
    failedReviewReport({
      number,
      type: "issue",
      pull_head_sha: "unknown",
      item_source_revision: sourceRevision,
    }),
    "utf8",
  );
  return { itemsDir, reportPath, itemPath, statePath, issue, sourceRevision, number };
}

function issueRetryGhMock(
  issue: ReturnType<typeof failedIssueRetryFixture>["issue"],
  dispatchBody: string,
): string {
  return `#!/usr/bin/env node
const args = process.argv.slice(2);
const path = args.find((arg) => arg.startsWith("repos/")) || "";
if (/\\/issues\\/${issue.number}\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify(args.includes("--slurp") ? [[]] : []));
  process.exit(0);
}
if (path.endsWith("/issues/${issue.number}")) {
  console.log(${JSON.stringify(JSON.stringify(issue))});
  process.exit(0);
}
if (path === "repos/openclaw/clawsweeper") {
  console.log("main");
  process.exit(0);
}
if (path.endsWith("/dispatches") && args.includes("POST")) {
  ${dispatchBody}
} else {
  console.error("unexpected gh args: " + args.join(" "));
  process.exit(1);
}
`;
}

function runFailedIssueRetry(
  fixture: ReturnType<typeof failedIssueRetryFixture>,
  extraArgs: string[] = [],
): void {
  execFileSync(process.execPath, [
    "dist/clawsweeper.js",
    "retry-failed-reviews",
    "--target-repo",
    "openclaw/openclaw",
    "--items-dir",
    fixture.itemsDir,
    "--item-number",
    String(fixture.number),
    "--workflow-ref",
    "main",
    "--report-path",
    fixture.reportPath,
    ...extraArgs,
  ]);
}

test("failed review retry eligibility requires infrastructure failure and matching live head", () => {
  const markdown = failedReviewReport();
  const now = Date.parse("2026-06-05T20:00:00Z");

  assert.equal(isInfrastructureFailedReviewForTest(markdown), true);
  assert.deepEqual(
    failedReviewRetryEligibilityForTest({
      markdown,
      liveState: "open",
      liveHeadSha: "abc123def456",
      now,
      maxAttempts: 2,
      cooldownMs: 45 * 60 * 1000,
    }),
    {
      repo: "openclaw/openclaw",
      number: 4242,
      action: "planned_failed_review_retry",
      reason: "eligible infrastructure failed review at head abc123def456",
      headSha: "abc123def456",
      revisionKind: "pull_head_sha",
      revision: "abc123def456",
      attempts: 0,
    },
  );
  assert.equal(
    failedReviewRetryEligibilityForTest({
      markdown,
      liveState: "open",
      liveHeadSha: "def456abc123",
      now,
      maxAttempts: 2,
      cooldownMs: 45 * 60 * 1000,
    }).action,
    "skipped_stale_head",
  );
  assert.equal(
    failedReviewRetryEligibilityForTest({
      markdown: failedReviewReport({ review_status: "complete" }),
      liveState: "open",
      liveHeadSha: "abc123def456",
      now,
      maxAttempts: 2,
      cooldownMs: 45 * 60 * 1000,
    }).action,
    "skipped_not_failed_review",
  );
});

test("failed issue reviews retry at a matching live source revision", () => {
  const markdown = failedReviewReport({
    type: "issue",
    pull_head_sha: "unknown",
    item_source_revision: "issue-source-revision",
  });
  const options = {
    markdown,
    liveState: "open",
    liveSourceRevision: "issue-source-revision",
    now: Date.parse("2026-06-05T20:00:00Z"),
    maxAttempts: 2,
    cooldownMs: 45 * 60 * 1000,
  };

  assert.deepEqual(failedReviewRetryEligibilityForTest(options), {
    repo: "openclaw/openclaw",
    number: 4242,
    action: "planned_failed_review_retry",
    reason: "eligible infrastructure failed review at source revision issue-source-revision",
    revisionKind: "item_source_revision",
    revision: "issue-source-revision",
    attempts: 0,
  });
  assert.equal(
    failedReviewRetryEligibilityForTest({
      ...options,
      liveSourceRevision: "new-source-revision",
    }).action,
    "skipped_stale_revision",
  );
  assert.equal(
    failedReviewRetryEligibilityForTest({
      ...options,
      markdown: failedReviewReport({
        type: "issue",
        pull_head_sha: "unknown",
        item_source_revision: "unknown",
      }),
    }).action,
    "skipped_missing_report_revision",
  );
  assert.equal(
    failedReviewRetryEligibilityForTest({
      ...options,
      markdown: failedReviewReport({
        type: "issue",
        pull_head_sha: "unknown",
        item_source_revision: "issue-source-revision",
        failed_review_retry_revision_kind: "item_source_revision",
        failed_review_retry_revision: "issue-source-revision",
        failed_review_retry_count: 1,
        failed_review_retry_last_at: "2026-06-05T19:30:00Z",
      }),
    }).action,
    "skipped_retry_cooldown",
  );
  assert.equal(
    failedReviewRetryEligibilityForTest({
      ...options,
      markdown: failedReviewReport({
        type: "issue",
        pull_head_sha: "unknown",
        item_source_revision: "issue-source-revision",
        failed_review_retry_revision_kind: "item_source_revision",
        failed_review_retry_revision: "issue-source-revision",
        failed_review_retry_count: 2,
        failed_review_retry_last_at: "2026-06-05T18:00:00Z",
      }),
    }).action,
    "skipped_retry_exhausted",
  );
});

test("failed review retry eligibility treats Codex rate limits as infrastructure failures", () => {
  const markdown = failedReviewReport({
    repository: "steipete/oracle",
    number: 250,
  }).replace(
    "Codex worker timed out after 600000ms with ETIMEDOUT.",
    [
      "stream disconnected: Rate limit reached for hidden-model (for limit test) on tokens per min (TPM). Please try again in 581ms.",
      "ERROR: The model quoted-model does not exist or you do not have access to it.",
    ].join("\n"),
  );

  assert.equal(isInfrastructureFailedReviewForTest(markdown), true);
});

test("failed review retry eligibility treats model access failures as terminal", () => {
  const markdown = failedReviewReport({ review_terminal_failure: true })
    .replaceAll(
      "Codex review failed: timeout.",
      "Codex review failed: model unavailable or access denied.",
    )
    .replaceAll(
      "Codex worker timed out after 600000ms with ETIMEDOUT.",
      [
        "ERROR: stream disconnected before completion: The model hidden-model does not exist or you do not have access to it.",
        "- **codex terminal error:** ERROR: stream disconnected before completion: The model hidden-model does not exist or you do not have access to it.",
      ].join("\n"),
    );

  assert.equal(isInfrastructureFailedReviewForTest(markdown), false);
  assert.equal(
    failedReviewRetryEligibilityForTest({
      markdown,
      liveState: "open",
      liveHeadSha: "abc123def456",
      now: Date.parse("2026-06-05T20:00:00Z"),
      maxAttempts: 2,
      cooldownMs: 45 * 60 * 1000,
    }).action,
    "skipped_non_infrastructure_failure",
  );
});

test("failed review retry ignores terminal-looking text outside dedicated evidence", () => {
  const markdown = failedReviewReport().replace(
    "## Summary",
    [
      "Contributor-controlled text: ERROR: The model hidden-model does not exist or you do not have access to it.",
      "",
      "## Summary",
    ].join("\n"),
  );

  assert.equal(isInfrastructureFailedReviewForTest(markdown), true);
});

test("failed review retry ignores terminal-looking text injected into rendered evidence", () => {
  const markdown = failedReviewReport().replace(
    "Codex worker timed out after 600000ms with ETIMEDOUT.",
    [
      "Codex worker timed out after 600000ms with ETIMEDOUT.",
      "- **codex terminal error:** ERROR: The model fake does not exist or you do not have access to it.",
    ].join("\n"),
  );

  assert.equal(isInfrastructureFailedReviewForTest(markdown), true);
});

test("failed review retry eligibility enforces cooldown and max attempts per head", () => {
  const now = Date.parse("2026-06-05T20:00:00Z");
  const recent = failedReviewReport({
    failed_review_retry_head_sha: "abc123def456",
    failed_review_retry_count: 1,
    failed_review_retry_last_at: "2026-06-05T19:30:00Z",
  });
  const exhausted = failedReviewReport({
    failed_review_retry_head_sha: "abc123def456",
    failed_review_retry_count: 2,
    failed_review_retry_last_at: "2026-06-05T18:00:00Z",
  });

  assert.equal(
    failedReviewRetryEligibilityForTest({
      markdown: recent,
      liveState: "open",
      liveHeadSha: "abc123def456",
      now,
      maxAttempts: 2,
      cooldownMs: 45 * 60 * 1000,
    }).action,
    "skipped_retry_cooldown",
  );
  assert.equal(
    failedReviewRetryEligibilityForTest({
      markdown: exhausted,
      liveState: "open",
      liveHeadSha: "abc123def456",
      now,
      maxAttempts: 2,
      cooldownMs: 45 * 60 * 1000,
    }).action,
    "skipped_retry_exhausted",
  );
});

test("failed issue retry dispatch binds the expected source revision", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const reportPath = join(root, "failed-review-retry-report.json");
    const dispatchPath = join(root, "dispatch.json");
    const issue = {
      number: 4343,
      title: "Failed issue review retry sample",
      body: "Issue body",
      html_url: "https://github.com/openclaw/openclaw/issues/4343",
      created_at: "2026-06-01T00:00:00Z",
      updated_at: "2026-06-01T01:00:00Z",
      closed_at: null,
      state: "open",
      locked: false,
      active_lock_reason: null,
      author_association: "CONTRIBUTOR",
      user: { login: "contributor" },
      labels: [],
      comments: 0,
      pull_request: null,
    };
    const sourceRevision = itemSourceRevisionSha256ForTest(issue, []);
    mkdirSync(itemsDir, { recursive: true });
    writeFileSync(
      join(itemsDir, "4343.md"),
      failedReviewReport({
        number: 4343,
        type: "issue",
        pull_head_sha: "unknown",
        item_source_revision: sourceRevision,
      }),
      "utf8",
    );

    const ghMock = `#!/usr/bin/env node
const args = process.argv.slice(2);
const path = args.find((arg) => arg.startsWith("repos/")) || "";
if (/\\/issues\\/4343\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify(args.includes("--slurp") ? [[]] : []));
  process.exit(0);
}
if (path.endsWith("/issues/4343")) {
  console.log(${JSON.stringify(JSON.stringify(issue))});
  process.exit(0);
}
if (path === "repos/openclaw/clawsweeper") {
  console.log("main");
  process.exit(0);
}
if (path.endsWith("/dispatches") && args.includes("POST")) {
  require("node:fs").writeFileSync(${JSON.stringify(dispatchPath)}, JSON.stringify(args));
  process.exit(0);
}
console.error("unexpected gh args: " + args.join(" "));
process.exit(1);
`;

    withMockGh(root, ghMock, () => {
      execFileSync(process.execPath, [
        "dist/clawsweeper.js",
        "retry-failed-reviews",
        "--target-repo",
        "openclaw/openclaw",
        "--items-dir",
        itemsDir,
        "--item-number",
        "4343",
        "--workflow-ref",
        "test-branch",
        "--report-path",
        reportPath,
      ]);
      const rejected = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
        action: string;
        reason: string;
      }>;
      assert.equal(rejected[0]?.action, "skipped_dispatch_failed");
      assert.match(rejected[0]?.reason ?? "", /default branch \(main\).*test-branch/);
      assert.doesNotMatch(
        readFileSync(join(itemsDir, "4343.md"), "utf8"),
        /^failed_review_retry_count:/m,
      );

      execFileSync(process.execPath, [
        "dist/clawsweeper.js",
        "retry-failed-reviews",
        "--target-repo",
        "openclaw/openclaw",
        "--items-dir",
        itemsDir,
        "--item-number",
        "4343",
        "--workflow-ref",
        "main",
        "--report-path",
        reportPath,
      ]);
    });

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
      action: string;
      revisionKind?: string;
      revision?: string;
    }>;
    assert.equal(report.length, 1);
    assert.equal(report[0]?.action, "dispatched_failed_review_retry");
    assert.equal(report[0]?.revisionKind, "item_source_revision");
    assert.equal(report[0]?.revision, sourceRevision);
    const dispatch = JSON.parse(readFileSync(dispatchPath, "utf8")) as string[];
    assert.ok(dispatch.includes("repos/openclaw/clawsweeper/dispatches"));
    assert.ok(dispatch.includes("event_type=clawsweeper_target_sweep"));
    assert.ok(dispatch.includes(`client_payload[expected_source_revision]=${sourceRevision}`));
    assert.ok(dispatch.includes("client_payload[source_revision_requeue_count]=0"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed issue retry bounds a hung GitHub fetch and flushes its report", () => {
  const root = mkdtempSync(tmpPrefix);
  const fixture = failedIssueRetryFixture(root, 4344);
  const maxRuntimeMs = 2_200;
  try {
    const startedAt = Date.now();
    withMockGh(root, "setTimeout(() => {}, 10_000);", () => {
      runFailedIssueRetry(fixture, ["--max-runtime-ms", String(maxRuntimeMs)]);
    });
    assert.ok(Date.now() - startedAt < 4_000, "hung gh exceeded the retry runtime bound");
    const report = JSON.parse(readFileSync(fixture.reportPath, "utf8")) as Array<{
      number: number;
      action: string;
      reason: string;
    }>;
    assert.deepEqual(report, [
      {
        number: 0,
        action: "skipped_runtime_budget",
        reason: report[0]?.reason,
      },
    ]);
    assert.match(report[0]?.reason ?? "", new RegExp(`max runtime ${maxRuntimeMs}ms reached`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed issue retry checkpoints an ambiguous dispatch and prevents an immediate duplicate", () => {
  const root = mkdtempSync(tmpPrefix);
  const fixture = failedIssueRetryFixture(root, 4345);
  const originalMarkdown = readFileSync(fixture.itemPath, "utf8");
  const dispatchCountPath = join(root, "dispatch-count.txt");
  const incrementDispatchCount = `
const fs = require("node:fs");
const counter = ${JSON.stringify(dispatchCountPath)};
const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
fs.writeFileSync(counter, String(count + 1));
`;
  try {
    withMockGh(
      root,
      issueRetryGhMock(fixture.issue, `${incrementDispatchCount}\nsetTimeout(() => {}, 10_000);`),
      () => runFailedIssueRetry(fixture, ["--max-runtime-ms", "2200"]),
    );

    const firstReport = JSON.parse(readFileSync(fixture.reportPath, "utf8")) as Array<{
      action: string;
      reason?: string;
    }>;
    assert.equal(firstReport.at(-1)?.action, "skipped_runtime_budget", JSON.stringify(firstReport));
    const checkpointed = readFileSync(fixture.itemPath, "utf8");
    assert.match(checkpointed, /^failed_review_retry_status: dispatch_failed$/m);
    assert.match(checkpointed, /^failed_review_retry_count: 1$/m);
    assert.match(checkpointed, /^failed_review_retry_revision_kind: item_source_revision$/m);
    assert.match(
      checkpointed,
      new RegExp(`^failed_review_retry_revision: ${fixture.sourceRevision}$`, "m"),
    );
    assert.equal((checkpointed.match(/^## Failed Review Retry$/gm) ?? []).length, 1);
    assert.equal(readFileSync(dispatchCountPath, "utf8"), "1");
    const retryState = JSON.parse(readFileSync(fixture.statePath, "utf8")) as {
      status: string;
      attempts: number;
      revision: string;
    };
    assert.deepEqual(
      {
        status: retryState.status,
        attempts: retryState.attempts,
        revision: retryState.revision,
      },
      { status: "dispatch_failed", attempts: 1, revision: fixture.sourceRevision },
    );

    // The generated sidecar is authoritative; review records are not published by this lane.
    writeFileSync(fixture.itemPath, originalMarkdown, "utf8");

    withMockGh(
      root,
      issueRetryGhMock(fixture.issue, `${incrementDispatchCount}\nprocess.exit(0);`),
      () => runFailedIssueRetry(fixture),
    );
    const secondReport = JSON.parse(readFileSync(fixture.reportPath, "utf8")) as Array<{
      action: string;
      attempts?: number;
    }>;
    assert.equal(secondReport[0]?.action, "skipped_retry_cooldown");
    assert.equal(secondReport[0]?.attempts, 1);
    assert.equal(readFileSync(dispatchCountPath, "utf8"), "1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed issue retry records dispatch success before later eligibility checks", () => {
  const root = mkdtempSync(tmpPrefix);
  const fixture = failedIssueRetryFixture(root, 4346);
  const originalMarkdown = readFileSync(fixture.itemPath, "utf8");
  const dispatchCountPath = join(root, "dispatch-count.txt");
  const incrementDispatchCount = `
const fs = require("node:fs");
const counter = ${JSON.stringify(dispatchCountPath)};
const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
fs.writeFileSync(counter, String(count + 1));
`;
  try {
    withMockGh(
      root,
      issueRetryGhMock(
        fixture.issue,
        `${incrementDispatchCount}\nsetTimeout(() => process.exit(0), 1300);`,
      ),
      () => runFailedIssueRetry(fixture, ["--max-runtime-ms", "4000"]),
    );
    const firstReport = JSON.parse(readFileSync(fixture.reportPath, "utf8")) as Array<{
      action: string;
      reason?: string;
    }>;
    assert.equal(
      firstReport[0]?.action,
      "dispatched_failed_review_retry",
      JSON.stringify(firstReport),
    );
    const dispatched = readFileSync(fixture.itemPath, "utf8");
    assert.match(dispatched, /^failed_review_retry_status: dispatched$/m);
    assert.match(dispatched, /^failed_review_retry_count: 1$/m);
    assert.equal((dispatched.match(/^## Failed Review Retry$/gm) ?? []).length, 1);
    const retryState = JSON.parse(readFileSync(fixture.statePath, "utf8")) as {
      status: string;
      attempts: number;
    };
    assert.equal(retryState.status, "dispatched");
    assert.equal(retryState.attempts, 1);

    writeFileSync(fixture.itemPath, originalMarkdown, "utf8");

    withMockGh(
      root,
      issueRetryGhMock(fixture.issue, `${incrementDispatchCount}\nprocess.exit(0);`),
      () => runFailedIssueRetry(fixture),
    );
    const secondReport = JSON.parse(readFileSync(fixture.reportPath, "utf8")) as Array<{
      action: string;
      attempts?: number;
    }>;
    assert.equal(secondReport[0]?.action, "skipped_retry_cooldown");
    assert.equal(secondReport[0]?.attempts, 1);
    assert.equal(readFileSync(dispatchCountPath, "utf8"), "1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed issue retry limit counts checkpointed ambiguous dispatches", () => {
  const root = mkdtempSync(tmpPrefix);
  const first = failedIssueRetryFixture(root, 4347);
  const second = failedIssueRetryFixture(root, 4348);
  const dispatchCountPath = join(root, "dispatch-count.txt");
  const issues = JSON.stringify({ [first.number]: first.issue, [second.number]: second.issue });
  const ghMock = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const path = args.find((arg) => arg.startsWith("repos/")) || "";
const issues = ${issues};
const issueMatch = path.match(/\\/issues\\/(\\d+)$/);
if (/\\/issues\\/\\d+\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify(args.includes("--slurp") ? [[]] : []));
  process.exit(0);
}
if (issueMatch && issues[issueMatch[1]]) {
  console.log(JSON.stringify(issues[issueMatch[1]]));
  process.exit(0);
}
if (path === "repos/openclaw/clawsweeper") {
  console.log("main");
  process.exit(0);
}
if (path.endsWith("/dispatches") && args.includes("POST")) {
  const counter = ${JSON.stringify(dispatchCountPath)};
  const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
  fs.writeFileSync(counter, String(count + 1));
  console.error("dispatch response lost after acceptance");
  process.exit(1);
}
console.error("unexpected gh args: " + args.join(" "));
process.exit(1);
`;
  try {
    withMockGh(root, ghMock, () => {
      execFileSync(process.execPath, [
        "dist/clawsweeper.js",
        "retry-failed-reviews",
        "--target-repo",
        "openclaw/openclaw",
        "--items-dir",
        first.itemsDir,
        "--limit",
        "1",
        "--workflow-ref",
        "main",
        "--report-path",
        first.reportPath,
      ]);
    });

    const report = JSON.parse(readFileSync(first.reportPath, "utf8")) as Array<{
      number: number;
      action: string;
      attempts?: number;
    }>;
    assert.deepEqual(
      report.map(({ number, action, attempts }) => ({ number, action, attempts })),
      [{ number: 4347, action: "skipped_dispatch_failed", attempts: 1 }],
    );
    assert.equal(readFileSync(dispatchCountPath, "utf8"), "1");
    assert.match(readFileSync(first.itemPath, "utf8"), /^failed_review_retry_count: 1$/m);
    assert.doesNotMatch(readFileSync(second.itemPath, "utf8"), /^failed_review_retry_count:/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expected issue source revision aborts drift and writes a requeue marker", () => {
  const root = mkdtempSync(tmpPrefix);
  const expectedSourceRevision = "a".repeat(64);
  const actualSourceRevision = "b".repeat(64);
  try {
    assert.doesNotThrow(() =>
      enforceExpectedIssueSourceRevisionForTest({
        expectedSourceRevision,
        itemKind: "issue",
        repo: "openclaw/openclaw",
        number: 4343,
        sourceRevision: expectedSourceRevision,
        artifactDir: root,
      }),
    );
    assert.throws(
      () =>
        enforceExpectedIssueSourceRevisionForTest({
          expectedSourceRevision,
          itemKind: "issue",
          repo: "openclaw/openclaw",
          number: 4343,
          sourceRevision: actualSourceRevision,
          artifactDir: root,
        }),
      /changed before review/,
    );
    const marker = JSON.parse(
      readFileSync(join(root, "source-revision-mismatch.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(marker.target_repo, "openclaw/openclaw");
    assert.equal(marker.item_number, 4343);
    assert.equal(marker.expected_source_revision, expectedSourceRevision);
    assert.equal(marker.actual_source_revision, actualSourceRevision);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sweep workflow forwards source revision and bounds drift requeue", () => {
  const workflow = readFileSync(".github/workflows/sweep.yml", "utf8");

  assert.match(workflow, /EXPECTED_SOURCE_REVISION:.*client_payload\.expected_source_revision/);
  assert.match(workflow, /--expected-source-revision "\$EXPECTED_SOURCE_REVISION"/);
  assert.match(
    workflow,
    /requeue-source-revision-drift:\r?\n\s+name: Requeue source-revision drift/,
  );
  assert.match(workflow, /name: review-source-revision-mismatch-\$\{\{ matrix\.shard \}\}/);
  assert.match(workflow, /requeue-source-revision-drift:[\s\S]*?contents: write/);
  assert.match(workflow, /review:[\s\S]*?permissions:\r?\n\s+contents: read/);
  assert.match(workflow, /\[ "\$REQUEUE_COUNT" -ge 1 \]/);
  assert.match(workflow, /expected_source_revision: \$expected_source_revision/);
  assert.match(workflow, /source_revision_requeue_count: "1"/);
});

test("failed retry metadata survives a repeated failure at the same revision", () => {
  const previous = `${failedReviewReport({
    type: "issue",
    pull_head_sha: "unknown",
    item_source_revision: "issue-source-revision",
    failed_review_retry_status: "dispatched",
    failed_review_retry_count: 1,
    failed_review_retry_last_at: "2026-06-05T19:30:00Z",
    failed_review_retry_revision_kind: "item_source_revision",
    failed_review_retry_revision: "issue-source-revision",
    failed_review_retry_reason: JSON.stringify("timeout"),
  })}

## Failed Review Retry

- status: dispatched
- attempts: 1/2
`;
  const repeatedFailure = failedReviewReport({
    type: "issue",
    pull_head_sha: "unknown",
    item_source_revision: "issue-source-revision",
  });
  const preserved = preserveFailedReviewRetryMetadataForTest(previous, repeatedFailure);

  assert.match(preserved, /^failed_review_retry_status: dispatched$/m);
  assert.match(preserved, /^failed_review_retry_count: 1$/m);
  assert.match(preserved, /^failed_review_retry_revision_kind: item_source_revision$/m);
  assert.match(preserved, /^failed_review_retry_revision: issue-source-revision$/m);
  assert.match(preserved, /^## Failed Review Retry$/m);
  assert.doesNotMatch(
    preserveFailedReviewRetryMetadataForTest(
      previous,
      failedReviewReport({
        type: "issue",
        pull_head_sha: "unknown",
        item_source_revision: "changed-source-revision",
      }),
    ),
    /^failed_review_retry_status:/m,
  );
  assert.doesNotMatch(
    preserveFailedReviewRetryMetadataForTest(
      previous,
      failedReviewReport({
        type: "issue",
        pull_head_sha: "unknown",
        item_source_revision: "issue-source-revision",
        review_status: "complete",
      }),
    ),
    /^failed_review_retry_status:/m,
  );
});

test("failed review retry exhaustion is idempotent for the same head", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const reportPath = join(root, "failed-review-retry-report.json");
    const itemPath = join(itemsDir, "4242.md");
    mkdirSync(itemsDir, { recursive: true });
    writeFileSync(
      itemPath,
      failedReviewReport({
        failed_review_retry_head_sha: "abc123def456",
        failed_review_retry_count: 2,
        failed_review_retry_last_at: "2026-06-05T18:00:00Z",
      }),
      "utf8",
    );

    const ghMock = `#!/usr/bin/env node
const args = process.argv.slice(2);
const path = args.find((arg) => arg.startsWith("repos/")) || "";
if (path.endsWith("/issues/4242")) {
  console.log(JSON.stringify({
    number: 4242,
    title: "Failed review retry sample",
    html_url: "https://github.com/openclaw/openclaw/pull/4242",
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T01:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "contributor" },
    labels: [],
    pull_request: {}
  }));
  process.exit(0);
}
if (path.endsWith("/pulls/4242")) {
  console.log("abc123def456");
  process.exit(0);
}
console.error("unexpected gh args: " + args.join(" "));
process.exit(1);
`;

    const runRetry = () => {
      execFileSync(process.execPath, [
        "dist/clawsweeper.js",
        "retry-failed-reviews",
        "--target-repo",
        "openclaw/openclaw",
        "--items-dir",
        itemsDir,
        "--item-number",
        "4242",
        "--max-attempts",
        "2",
        "--cooldown-minutes",
        "45",
        "--report-path",
        reportPath,
      ]);
    };

    withMockGh(root, ghMock, () => {
      runRetry();
      const afterFirstRun = readFileSync(itemPath, "utf8");
      assert.match(afterFirstRun, /^failed_review_retry_status: exhausted$/m);
      assert.equal((afterFirstRun.match(/^## Failed Review Retry$/gm) ?? []).length, 1);

      runRetry();
      const afterSecondRun = readFileSync(itemPath, "utf8");
      assert.equal(afterSecondRun, afterFirstRun);
    });

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
      action: string;
      number: number;
    }>;
    assert.deepEqual(report, [
      {
        repo: "openclaw/openclaw",
        number: 4242,
        action: "skipped_retry_already_exhausted",
        reason: "retry attempts exhausted for head abc123def456: 2/2",
        headSha: "abc123def456",
        revisionKind: "pull_head_sha",
        revision: "abc123def456",
        attempts: 2,
        reportPath: itemPath,
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
