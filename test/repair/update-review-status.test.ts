import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeReviewProgressSection,
  parseOptions,
  renderReviewProgressSection,
  reviewStatusMutationReceiptIsValid,
  terminalReviewStatusCopy,
} from "../../dist/repair/update-review-status.js";

const runUrl = "https://github.com/openclaw/clawsweeper/actions/runs/12345";

test("terminal review status renders bounded reason-specific guidance", () => {
  const findings = renderReviewProgressSection({
    state: "blocked",
    failureReason: "findings",
    runUrl,
  });
  assert.match(findings, /no review verdict was produced/i);
  assert.match(findings, /will not retry this unchanged revision/i);
  assert.match(findings, /remove and rotate/i);
  assert.match(findings, /intentional test fixture/i);
  assert.doesNotMatch(findings, /secret-[A-Za-z0-9]+|filename|scanner output:/i);

  assert.match(terminalReviewStatusCopy("incomplete_source").next, /No contributor action/i);
  assert.match(terminalReviewStatusCopy("source_incompatible").next, /Update or rebase/i);
});

test("review progress replaces one marker-backed section in place", () => {
  const acknowledgement = [
    "<!-- clawsweeper-pr-ack:opened item=42 -->",
    "🦞👀",
    "ClawSweeper picked this up.",
  ].join("\n");
  const blocked = mergeReviewProgressSection(acknowledgement, {
    state: "blocked",
    failureReason: "findings",
    runUrl,
  });
  const reviewing = mergeReviewProgressSection(blocked, {
    state: "reviewing",
    failureReason: null,
    runUrl,
  });
  assert.equal((reviewing.match(/clawsweeper-review-progress:start/g) ?? []).length, 1);
  assert.equal((reviewing.match(/clawsweeper-review-progress:end/g) ?? []).length, 1);
  assert.match(reviewing, /review in progress/i);
  assert.doesNotMatch(reviewing, /review blocked|remove and rotate/i);
  assert.match(reviewing, /clawsweeper-pr-ack:opened item=42/);
  const complete = mergeReviewProgressSection(reviewing, {
    state: "complete",
    failureReason: null,
    runUrl,
  });
  assert.equal((complete.match(/clawsweeper-review-progress:start/g) ?? []).length, 1);
  assert.match(complete, /review complete/i);
  assert.doesNotMatch(complete, /review in progress|review blocked/i);
  const closed = mergeReviewProgressSection(reviewing, {
    state: "closed",
    failureReason: null,
    runUrl,
  });
  assert.match(closed, /review ended/i);
  assert.match(closed, /pull request closed/i);
  assert.doesNotMatch(closed, /review in progress|review blocked/i);
});

test("review status mutation receipt requires the exact server-returned body", () => {
  const expectedBody = "<!-- clawsweeper-pr-ack:opened item=42 -->\n\nstatus";
  const receipt = {
    id: 4200,
    updated_at: "2026-09-03T20:00:00Z",
    body: expectedBody,
  };
  assert.equal(reviewStatusMutationReceiptIsValid(receipt, 4200, expectedBody), true);
  assert.equal(
    reviewStatusMutationReceiptIsValid({ ...receipt, body: "different body" }, 4200, expectedBody),
    false,
  );
});

test("review status options reject arbitrary reasons and unsafe run links", () => {
  const base = [
    "--repo",
    "openclaw/openclaw",
    "--item-number",
    "42",
    "--status-comment-id",
    "4200",
    "--state",
    "blocked",
  ];
  assert.throws(() => parseOptions([...base, "--failure-reason", "raw-scanner-output"]));
  assert.throws(() =>
    parseOptions([
      ...base,
      "--failure-reason",
      "findings",
      "--run-url",
      "https://example.com/not-a-run",
    ]),
  );
  assert.equal(
    parseOptions([...base, "--failure-reason", "findings", "--run-url", runUrl]).failureReason,
    "findings",
  );
  assert.equal(
    parseOptions([
      "--repo",
      "openclaw/openclaw",
      "--item-number",
      "42",
      "--status-comment-id",
      "4200",
      "--state",
      "complete",
    ]).state,
    "complete",
  );
  assert.equal(
    parseOptions([
      "--repo",
      "openclaw/openclaw",
      "--item-number",
      "42",
      "--status-comment-id",
      "4200",
      "--state",
      "closed",
    ]).state,
    "closed",
  );
});
