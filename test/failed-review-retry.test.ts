import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  failedReviewRetryEligibilityForTest,
  isInfrastructureFailedReviewForTest,
} from "../dist/clawsweeper.js";
import { tmpPrefix, withMockGh, workPlanCandidateReport } from "./helpers.ts";

function failedReviewReport(overrides = {}) {
  return `${workPlanCandidateReport({
    repository: "openclaw/openclaw",
    number: 4242,
    type: "pull_request",
    review_status: "failed",
    pull_head_sha: "abc123def456",
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
        attempts: 2,
        reportPath: itemPath,
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
