import assert from "node:assert/strict";
import test from "node:test";

import { adaptiveReviewBudgetForPullRequest } from "../../dist/repair/adaptive-review-budget.js";
import { mediaFixtureUrls } from "../primary-body-fixture.ts";

test("adaptive review budget includes unknown GitHub attachments once and excludes known images", () => {
  const { attachment, legacyAttachment, prefix } = mediaFixtureUrls;
  assert.equal(adaptiveReviewBudgetForPullRequest({ body: prefix }).mediaProofTimeoutMs, 0);
  const budget = adaptiveReviewBudgetForPullRequest({
    title: attachment,
    body: [
      attachment,
      legacyAttachment,
      prefix,
      attachment.replace("github.com", "example.invalid"),
    ].join("\n"),
  });
  assert.equal(budget.mediaProofTimeoutMs, 240_000);
  assert.equal(budget.codexTimeoutMs, 600_000);
});

test("adaptive review budget caps GitHub attachment preprocessing at four URLs", () => {
  const body = [1, 2, 3, 4, 5]
    .map((n) => mediaFixtureUrls.attachment.replace(/.$/, String(n)))
    .join("\n");
  assert.equal(adaptiveReviewBudgetForPullRequest({ body }).mediaProofTimeoutMs, 480_000);
});

test("adaptive review budget normalizes REST aggregate and gh file shapes", () => {
  const aggregate = adaptiveReviewBudgetForPullRequest({
    changed_files: 71,
    additions: 4176,
    deletions: 0,
    body: [
      "https://uploads.example.invalid/proof-a.mov",
      "https://uploads.example.invalid/proof-b.mp4",
    ].join("\n"),
  });
  const files = adaptiveReviewBudgetForPullRequest({
    changedFiles: 71,
    additions: 4176,
    deletions: 0,
    files: Array.from({ length: 71 }, (_, index) => ({
      additions: index === 0 ? 4176 : 0,
      deletions: 0,
    })),
    body: [
      "https://uploads.example.invalid/proof-a.mov",
      "https://uploads.example.invalid/proof-b.mp4",
    ].join("\n"),
  });

  assert.deepEqual(aggregate, {
    codexTimeoutMs: 1_268_800,
    mediaProofTimeoutMs: 240_000,
  });
  assert.deepEqual(files, aggregate);
});

test("adaptive review budget caps video preprocessing allowance", () => {
  const budget = adaptiveReviewBudgetForPullRequest({
    body: [
      "https://uploads.example.invalid/one.mov",
      "https://uploads.example.invalid/two.mp4",
      "https://uploads.example.invalid/three.webm",
      "https://uploads.example.invalid/four.mkv",
      "https://uploads.example.invalid/five.avi",
    ].join("\n"),
  });

  assert.equal(budget.mediaProofTimeoutMs, 480_000);
  assert.equal(budget.codexTimeoutMs, 600_000);
});
