import assert from "node:assert/strict";
import test from "node:test";

import {
  isPublicationOnlyPostFlightJob,
  issueImplementationPublishedHeadBlock,
  postFlightOutcomeExitCode,
  publicationOnlyPostFlightAction,
  shouldFinalizePublicationOnlyPostFlight,
  summarizePostFlightReport,
} from "../../dist/repair/post-flight-report.js";

test("post-flight report succeeds only when every generated action completed", () => {
  assert.deepEqual(
    summarizePostFlightReport({
      actions: [
        { action: "finalize_fix_pr", status: "ready" },
        { action: "publish_fix_pr", status: "published" },
        { action: "post_merge_closeout", status: "executed" },
      ],
    }),
    {
      outcome: "success",
      detail: "all generated post-flight actions completed",
    },
  );
});

test("post-flight treats non-merge repair lanes as publication-only", () => {
  assert.equal(
    isPublicationOnlyPostFlightJob({
      allowed_actions: ["comment", "fix", "raise_pr"],
      blocked_actions: ["merge"],
      allow_merge: false,
    }),
    true,
  );
  assert.equal(
    isPublicationOnlyPostFlightJob({
      allowed_actions: ["comment", "fix", "raise_pr", "merge"],
      blocked_actions: [],
      allow_merge: true,
    }),
    false,
  );
  assert.equal(
    shouldFinalizePublicationOnlyPostFlight({
      hasPublicationReceipt: true,
      frontmatter: {
        allowed_actions: ["comment", "fix", "raise_pr"],
        blocked_actions: ["merge"],
        allow_merge: false,
      },
      automergeReplacement: true,
    }),
    false,
  );
  assert.equal(
    shouldFinalizePublicationOnlyPostFlight({
      hasPublicationReceipt: true,
      frontmatter: {
        allowed_actions: ["comment", "fix", "raise_pr"],
        blocked_actions: ["merge"],
        allow_merge: false,
      },
      automergeReplacement: false,
    }),
    true,
  );
});

test("publication-only completion requires the exact authorized repair head", () => {
  const action = { commit: "a".repeat(40) };
  const base = { action: "finalize_fix_pr", pr: "#123" };
  assert.equal(
    publicationOnlyPostFlightAction({
      action,
      base,
      pull: { state: "open", head: { sha: "a".repeat(40) } },
      view: {},
    }).status,
    "published",
  );
  assert.deepEqual(
    publicationOnlyPostFlightAction({
      action,
      base,
      pull: { state: "open", head: { sha: "b".repeat(40) } },
      view: {},
    }),
    {
      ...base,
      status: "blocked",
      reason: "published pull request head does not match the authorized repair commit",
    },
  );
});

test("issue implementation completion requires the exact published receipt head", () => {
  const expectedPublishedHeadSha = "a".repeat(40);
  assert.equal(
    issueImplementationPublishedHeadBlock({
      expectedPublishedHeadSha,
      pull: { head: { sha: expectedPublishedHeadSha } },
      view: {},
    }),
    "",
  );
  assert.equal(
    issueImplementationPublishedHeadBlock({
      expectedPublishedHeadSha,
      pull: { head: { sha: "b".repeat(40) } },
      view: { headRefOid: expectedPublishedHeadSha },
    }),
    "issue implementation pull request head does not match the published receipt",
  );
  assert.equal(
    issueImplementationPublishedHeadBlock({
      expectedPublishedHeadSha,
      pull: {},
      view: {},
    }),
    "issue implementation pull request head does not match the published receipt",
  );
});

test("post-flight report classifies terminal generated failures as blocked", () => {
  assert.deepEqual(
    summarizePostFlightReport({
      actions: [
        {
          action: "finalize_fix_pr",
          status: "blocked",
          reason: "checks are not clean",
        },
      ],
    }),
    {
      outcome: "blocked",
      detail: "finalize_fix_pr: checks are not clean",
    },
  );
  assert.equal(summarizePostFlightReport({ actions: [] }).outcome, "blocked");
});

test("post-flight report requests requeue only when every incomplete action is retryable", () => {
  assert.equal(
    summarizePostFlightReport({
      actions: [
        {
          action: "finalize_fix_pr",
          status: "blocked",
          reason: "base branch moved",
          retry_recommended: true,
        },
      ],
    }).outcome,
    "requeue",
  );
  assert.equal(
    summarizePostFlightReport({
      actions: [
        { action: "finalize_fix_pr", status: "blocked", retry_recommended: true },
        { action: "post_merge_closeout", status: "blocked", reason: "manual review required" },
      ],
    }).outcome,
    "blocked",
  );
});

test("post-flight exits nonzero for blocked and requeue reports", () => {
  assert.equal(postFlightOutcomeExitCode("success"), 0);
  assert.equal(postFlightOutcomeExitCode("blocked"), 1);
  assert.equal(postFlightOutcomeExitCode("requeue"), 1);
});
