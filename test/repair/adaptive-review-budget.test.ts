import assert from "node:assert/strict";
import test from "node:test";

import { VIDEO_PROOF_EXTENSIONS } from "../../dist/clawsweeper-media-proof.js";
import { MAX_MEDIA_PROOF_URLS, MEDIA_PROOF_TIMEOUT_MS } from "../../dist/media-proof-budget.js";
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
  assert.equal(budget.mediaProofTimeoutMs, 2 * MEDIA_PROOF_TIMEOUT_MS);
  assert.equal(budget.codexTimeoutMs, 600_000);
});

test("adaptive review budget caps GitHub attachment preprocessing at the media proof URL cap", () => {
  const body = Array.from({ length: MAX_MEDIA_PROOF_URLS + 1 }, (_, n) =>
    mediaFixtureUrls.attachment.replace(/.$/, String(n)),
  ).join("\n");
  assert.equal(
    adaptiveReviewBudgetForPullRequest({ body }).mediaProofTimeoutMs,
    MAX_MEDIA_PROOF_URLS * MEDIA_PROOF_TIMEOUT_MS,
  );
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
    mediaProofTimeoutMs: 2 * MEDIA_PROOF_TIMEOUT_MS,
  });
  assert.deepEqual(files, aggregate);
});

test("adaptive review budget caps video preprocessing allowance", () => {
  const extensions = [...VIDEO_PROOF_EXTENSIONS];
  const budget = adaptiveReviewBudgetForPullRequest({
    body: Array.from(
      { length: MAX_MEDIA_PROOF_URLS + 1 },
      (_, n) => `https://uploads.example.invalid/${n}${extensions[n % extensions.length]}`,
    ).join("\n"),
  });

  assert.equal(budget.mediaProofTimeoutMs, MAX_MEDIA_PROOF_URLS * MEDIA_PROOF_TIMEOUT_MS);
  assert.equal(budget.codexTimeoutMs, 600_000);
});
