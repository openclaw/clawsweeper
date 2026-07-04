import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { contextHasNonAutomationActivityAfterForTest } from "../dist/clawsweeper.js";

import {
  lowSignalCloseReport,
  prRatingReportSection,
  promotionGhMock,
  realBehaviorProofReportSection,
  reportFrontMatter,
  reportWithSyncedReviewComment,
  runApplyDecisionsForTest,
  tmpPrefix,
  withMockGh,
  workPlanCandidateReport,
} from "./helpers.ts";

test("command-only timeline activity is ignored only through the completed review", () => {
  const storedAtMs = Date.parse("2026-07-03T21:42:48Z");
  const reviewedAtMs = Date.parse("2026-07-03T21:44:48Z");
  const timelineEvent = (createdAt: string) => ({
    event: "commented",
    actor: "contributor",
    createdAt,
  });

  assert.equal(
    contextHasNonAutomationActivityAfterForTest({
      timeline: [timelineEvent("2026-07-03T21:43:00Z")],
      activityAfterMs: storedAtMs,
      ignoreTimelineCommentsThroughMs: reviewedAtMs,
    }),
    false,
  );
  assert.equal(
    contextHasNonAutomationActivityAfterForTest({
      timeline: [timelineEvent("2026-07-03T21:45:00Z")],
      activityAfterMs: storedAtMs,
      ignoreTimelineCommentsThroughMs: reviewedAtMs,
    }),
    true,
  );
});

test("apply-decisions skips advisory label sync when a close report changed since review", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(itemsDir, "321.md"),
      workPlanCandidateReport({
        decision: "close",
        action_taken: "proposed_close",
        close_reason: "implemented_on_main",
        confidence: "high",
        item_snapshot_hash: "reviewed-snapshot",
        item_updated_at: "2026-05-01T00:00:00Z",
        reproduction_status: "reproduced",
        reproduction_confidence: "high",
      }),
      "utf8",
    );

    const ghMock = `
const { appendFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] || "";
if (args[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Render work plans",
    html_url: "https://github.com/openclaw/clawsweeper/issues/321",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-03T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    pull_request: null
  }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "label" || args[0] === "issue") {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({ itemsDir, closedDir, plansDir, reportPath });
    });

    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(
      calls.some((args) => args[0] === "issue" && args[1] === "edit"),
      false,
    );
    assert.equal(
      calls.some((args) => args[0] === "label" && args[1] === "create"),
      false,
    );
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 321,
        action: "skipped_changed_since_review",
        reason: "updated_at changed",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions records PR label sync as ClawSweeper-owned churn", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    const itemPath = join(itemsDir, "74478.md");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      itemPath,
      `${reportFrontMatter({
        repository: "openclaw/clawsweeper",
        type: "pull_request",
        number: "74478",
        title: "Record PR label churn",
        url: "https://github.com/openclaw/clawsweeper/pull/74478",
        decision: "keep_open",
        close_reason: "none",
        confidence: "high",
        action_taken: "kept_open",
        review_status: "complete",
        local_checkout_access: "verified",
        author: "contributor",
        author_association: "CONTRIBUTOR",
        labels: JSON.stringify([]),
        item_category: "feature",
        requires_new_feature: "true",
        item_snapshot_hash: "snapshot-a",
        item_updated_at: "2026-05-19T20:00:00Z",
        pull_head_sha: "abc123def456",
      })}

## Summary

This PR has complete review metadata and needs only ClawSweeper-owned labels.

${realBehaviorProofReportSection({ evidenceKind: "screenshot" })}

${prRatingReportSection({ overallTier: "A" })}

## Feature Showcase

Status: showcase

Reason: This unlocks a notably useful maintainer workflow that did not exist before.

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`,
      "utf8",
    );

    const ghMock = `
const { appendFileSync, readFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] || "";
if (args[0] === "api" && /\\/issues\\/74478$/.test(path)) {
  console.log(JSON.stringify({
    number: 74478,
    title: "Record PR label churn",
    html_url: "https://github.com/openclaw/clawsweeper/pull/74478",
    created_at: "2026-05-19T19:00:00Z",
    updated_at: "2026-05-19T20:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "contributor" },
    labels: [],
    pull_request: {}
  }));
} else if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/74478\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/74478\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/pulls\\/74478$/.test(path)) {
  console.log(JSON.stringify({
    number: 74478,
    html_url: "https://github.com/openclaw/clawsweeper/pull/74478",
    state: "open",
    changed_files: 1,
    commits: 1,
    review_comments: 0,
    head: { sha: "abc123def456", ref: "branch", repo: { full_name: "fork/clawsweeper" } },
    base: { sha: "base-sha", ref: "main", repo: { full_name: "openclaw/clawsweeper" } },
    user: { login: "contributor" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/74478\\/(files|commits|comments)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/74478\\/comments(?:\\?|$)/.test(path)) {
  if (args.includes("--method") && args.includes("POST")) {
    const input = args[args.indexOf("--input") + 1];
    appendFileSync(logPath, JSON.stringify(["posted-comment-body", JSON.parse(readFileSync(input, "utf8")).body]) + "\\n");
    console.log(JSON.stringify({
      id: 987478,
      html_url: "https://github.com/openclaw/clawsweeper/pull/74478#issuecomment-987478"
    }));
  } else {
    console.log(JSON.stringify([[]]));
  }
} else if (args[0] === "label" && args[1] === "create") {
  console.log(JSON.stringify({ name: args[2] }));
} else if (args[0] === "issue" && args[1] === "edit") {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: ["--sync-comments-only", "--item-numbers", "74478"],
      });
    });

    const report = readFileSync(itemPath, "utf8");
    assert.match(report, /^labels_synced_at: /m);
    assert.match(report, /proof: sufficient/);
    assert.match(report, /proof: 📸 screenshot/);
    assert.match(report, /rating: 🦞 diamond lobster/);
    assert.match(report, /feature: ✨ showcase/);
    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert(
      calls.some(
        (args) => args[0] === "label" && args[1] === "create" && args[2] === "feature: ✨ showcase",
      ),
    );
    assert(
      calls.some(
        (args) =>
          args[0] === "issue" &&
          args[1] === "edit" &&
          args.includes("--add-label") &&
          args.includes("feature: ✨ showcase"),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions clears stale PR review labels when live head changed", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    const itemPath = join(itemsDir, "74481.md");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const staleLabels = [
      "P2",
      "rating: 🧂 unranked krab",
      "merge-risk: 🚨 session-state",
      "status: 🔁 re-review loop",
      "proof: sufficient",
    ];
    const sourceReport = `${reportFrontMatter({
      repository: "openclaw/openclaw",
      type: "pull_request",
      number: "74481",
      title: "Stale review label cleanup",
      url: "https://github.com/openclaw/openclaw/pull/74481",
      decision: "keep_open",
      close_reason: "none",
      confidence: "high",
      action_taken: "kept_open",
      review_status: "complete",
      local_checkout_access: "verified",
      author: "contributor",
      author_association: "CONTRIBUTOR",
      labels: JSON.stringify(staleLabels),
      item_snapshot_hash: "snapshot-a",
      item_updated_at: "2026-05-19T20:00:00Z",
      reviewed_at: "2026-05-19T20:00:00Z",
      pull_head_sha: "old-head",
      merge_risk_labels: JSON.stringify(["merge-risk: 🚨 session-state"]),
    })}

## Summary

This old report should not keep driving PR labels after the branch moves.

${realBehaviorProofReportSection()}

${prRatingReportSection({ overallTier: "F", proofTier: "F", patchTier: "F" })}

## Review Findings

Overall correctness: patch is incorrect

Overall confidence: 0.87

Full review comments:

- [P1] Old finding — src/runtime.ts:10
`;
    const synced = reportWithSyncedReviewComment(sourceReport, 74481);
    writeFileSync(itemPath, synced.report, "utf8");

    const ghMock = `
const { appendFileSync, readFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const comment = ${JSON.stringify(synced.comment)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] || "";
const staleLabels = ${JSON.stringify(staleLabels)};
if (args[0] === "api" && /\\/issues\\/74481$/.test(path)) {
  console.log(JSON.stringify({
    number: 74481,
    title: "Stale review label cleanup",
    html_url: "https://github.com/openclaw/openclaw/pull/74481",
    created_at: "2026-05-19T19:00:00Z",
    updated_at: "2026-05-19T20:10:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "contributor" },
    labels: staleLabels,
    pull_request: {}
  }));
} else if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/74481\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/74481\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/pulls\\/74481$/.test(path)) {
  console.log(JSON.stringify({
    number: 74481,
    html_url: "https://github.com/openclaw/openclaw/pull/74481",
    state: "open",
    changed_files: 1,
    commits: 2,
    review_comments: 0,
    head: { sha: "new-head", ref: "branch", repo: { full_name: "fork/openclaw" } },
    base: { sha: "base-sha", ref: "main", repo: { full_name: "openclaw/openclaw" } },
    user: { login: "contributor" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/74481\\/(files|commits|comments)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/74481\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[
    {
      id: 987481,
      html_url: "https://github.com/openclaw/openclaw/pull/74481#issuecomment-987481",
      body: comment,
      user: { login: "clawsweeper[bot]" },
      created_at: "2026-05-19T20:00:00Z",
      updated_at: "2026-05-19T20:00:00Z"
    }
  ]]));
} else if (args[0] === "api" && /\\/issues\\/comments\\/987481$/.test(path)) {
  const input = args[args.indexOf("--input") + 1];
  appendFileSync(logPath, JSON.stringify(["patched-review-body", JSON.parse(readFileSync(input, "utf8")).body]) + "\\n");
  console.log(JSON.stringify({
    id: 987481,
    html_url: "https://github.com/openclaw/openclaw/pull/74481#issuecomment-987481",
    updated_at: "2026-05-19T20:11:00Z"
  }));
} else if (args[0] === "issue" && args[1] === "edit") {
  console.log("");
} else if (args[0] === "label" && args[1] === "create") {
  console.log(JSON.stringify({ name: args[2] }));
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        targetRepo: "openclaw/openclaw",
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: ["--sync-comments-only", "--item-numbers", "74481"],
      });
    });

    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    const removedLabels = calls
      .filter((args) => args[0] === "issue" && args[1] === "edit")
      .map((args) => args[args.indexOf("--remove-label") + 1])
      .filter(Boolean)
      .sort();
    assert.deepEqual(removedLabels, [
      "merge-risk: 🚨 session-state",
      "proof: sufficient",
      "rating: 🧂 unranked krab",
      "status: 🔁 re-review loop",
    ]);
    const patchedBody = calls.find((args) => args[0] === "patched-review-body")?.[1] ?? "";
    assert.match(patchedBody, /Codex review: stale review; fresh review needed/);
    assert.match(patchedBody, /reviewed_sha=old-head current_sha=new-head/);
    assert.match(patchedBody, /clawsweeper-review-history v=1 total=1/);
    assert.match(
      patchedBody,
      /- reviewed 2026-05-19T20:00:00Z sha old-head :: needs maintainer review before merge\./,
    );
    assert.doesNotMatch(patchedBody, /clawsweeper-verdict:/);
    const updatedReport = readFileSync(itemPath, "utf8");
    assert.match(updatedReport, /^current_pull_head_sha: new-head$/m);
    assert.match(updatedReport, /^labels: \["P2"\]$/m);
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 74481,
        action: "review_comment_synced",
        reason: "updated durable Codex review comment",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions syncs fresh-head PR labels after a command-only re-review comment", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    const itemPath = join(itemsDir, "74482.md");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const sourceReport = `${reportFrontMatter({
      repository: "openclaw/openclaw",
      type: "pull_request",
      number: "74482",
      title: "Fresh head label restore after re-review",
      url: "https://github.com/openclaw/openclaw/pull/74482",
      decision: "keep_open",
      close_reason: "none",
      confidence: "high",
      action_taken: "kept_open",
      review_status: "complete",
      local_checkout_access: "verified",
      author: "contributor",
      author_association: "CONTRIBUTOR",
      labels: JSON.stringify([]),
      item_snapshot_hash: "snapshot-a",
      item_updated_at: "2026-07-03T21:42:48Z",
      reviewed_at: "2026-07-03T21:44:48Z",
      pull_head_sha: "bc60b889",
      merge_risk_labels: JSON.stringify(["merge-risk: 🚨 session-state"]),
    })}

## Summary

This fresh review must keep driving PR labels after its command-only re-review comment.

${realBehaviorProofReportSection()}

${prRatingReportSection({ overallTier: "A" })}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;
    const synced = reportWithSyncedReviewComment(sourceReport, 74482);
    writeFileSync(itemPath, synced.report, "utf8");

    const ghMock = `
const { appendFileSync, readFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const comment = ${JSON.stringify(synced.comment)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] || "";
const reReviewTimeline = [{
  id: 987483,
  event: "commented",
  actor: { login: "contributor" },
  created_at: "2026-07-03T21:43:00Z"
}];
if (args[0] === "api" && /\\/issues\\/74482$/.test(path)) {
  console.log(JSON.stringify({
    number: 74482,
    title: "Fresh head label restore after re-review",
    html_url: "https://github.com/openclaw/openclaw/pull/74482",
    created_at: "2026-07-03T19:00:00Z",
    updated_at: "2026-07-03T21:45:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "contributor" },
    labels: ["status: 📣 needs proof", "rating: 🦪 silver shellfish"],
    pull_request: {}
  }));
} else if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/74482\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  console.log("HTTP/2 200\\n\\n" + JSON.stringify(reReviewTimeline));
} else if (args[0] === "api" && /\\/issues\\/74482\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([reReviewTimeline]));
} else if (args[0] === "api" && /\\/pulls\\/74482$/.test(path)) {
  console.log(JSON.stringify({
    number: 74482,
    html_url: "https://github.com/openclaw/openclaw/pull/74482",
    state: "open",
    changed_files: 1,
    commits: 2,
    review_comments: 0,
    head: { sha: "bc60b889", ref: "branch", repo: { full_name: "fork/openclaw" } },
    base: { sha: "base-sha", ref: "main", repo: { full_name: "openclaw/openclaw" } },
    user: { login: "contributor" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/74482\\/(files|commits|comments)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/74482\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[
    {
      id: 987482,
      html_url: "https://github.com/openclaw/openclaw/pull/74482#issuecomment-987482",
      body: comment,
      user: { login: "clawsweeper[bot]" },
      created_at: "2026-07-03T21:33:21Z",
      updated_at: "2026-07-03T21:33:21Z"
    },
    {
      id: 987483,
      html_url: "https://github.com/openclaw/openclaw/pull/74482#issuecomment-987483",
      body: "Pushed a new head, please take another look.",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      created_at: "2026-07-03T21:42:28Z",
      updated_at: "2026-07-03T21:42:28Z"
    },
    {
      id: 987484,
      html_url: "https://github.com/openclaw/openclaw/pull/74482#issuecomment-987484",
      body: "@clawsweeper re-review",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      created_at: "2026-07-03T21:43:00Z",
      updated_at: "2026-07-03T21:43:00Z"
    }
  ]]));
} else if (args[0] === "api" && /\\/issues\\/comments\\/987482$/.test(path)) {
  const input = args[args.indexOf("--input") + 1];
  appendFileSync(logPath, JSON.stringify(["patched-review-body", JSON.parse(readFileSync(input, "utf8")).body]) + "\\n");
  console.log(JSON.stringify({
    id: 987482,
    html_url: "https://github.com/openclaw/openclaw/pull/74482#issuecomment-987482",
    updated_at: "2026-07-03T21:48:00Z"
  }));
} else if (args[0] === "issue" && args[1] === "edit") {
  console.log("");
} else if (args[0] === "label" && args[1] === "create") {
  console.log(JSON.stringify({ name: args[2] }));
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        targetRepo: "openclaw/openclaw",
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: ["--sync-comments-only", "--item-numbers", "74482"],
      });
    });

    const updatedReport = readFileSync(itemPath, "utf8");
    assert.match(updatedReport, /^labels_synced_at: /m);
    assert.match(updatedReport, /proof: sufficient/);
    assert.match(updatedReport, /rating: 🦞 diamond lobster/);
    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    assert(
      calls.some(
        (args) =>
          args[0] === "issue" &&
          args[1] === "edit" &&
          args.includes("--add-label") &&
          args.includes("rating: 🦞 diamond lobster"),
      ),
    );
    assert(
      calls.some(
        (args) =>
          args[0] === "issue" &&
          args[1] === "edit" &&
          args.includes("--remove-label") &&
          args.includes("status: 📣 needs proof"),
      ),
    );
    assert(
      calls.some(
        (args) =>
          args[0] === "issue" &&
          args[1] === "edit" &&
          args.includes("--remove-label") &&
          args.includes("rating: 🦪 silver shellfish"),
      ),
    );
    assert(
      calls.some(
        (args) =>
          args[0] === "issue" &&
          args[1] === "edit" &&
          args.includes("--add-label") &&
          args.includes("proof: sufficient"),
      ),
    );
    assert(
      calls.some(
        (args) =>
          args[0] === "issue" &&
          args[1] === "edit" &&
          args.includes("--add-label") &&
          args.includes("merge-risk: 🚨 session-state"),
      ),
    );
    const patchedBody = calls.find((args) => args[0] === "patched-review-body")?.[1] ?? "";
    assert.match(patchedBody, /Label justifications:/);
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 74482,
        action: "review_comment_synced",
        reason: "updated durable Codex review comment",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions skips fresh-head PR label sync when humans act after the review snapshot", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    const itemPath = join(itemsDir, "74483.md");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const sourceReport = `${reportFrontMatter({
      repository: "openclaw/openclaw",
      type: "pull_request",
      number: "74483",
      title: "Fresh head with human activity",
      url: "https://github.com/openclaw/openclaw/pull/74483",
      decision: "keep_open",
      close_reason: "none",
      confidence: "high",
      action_taken: "kept_open",
      review_status: "complete",
      local_checkout_access: "verified",
      author: "contributor",
      author_association: "CONTRIBUTOR",
      labels: JSON.stringify([]),
      item_snapshot_hash: "snapshot-a",
      item_updated_at: "2026-07-03T21:42:48Z",
      reviewed_at: "2026-07-03T21:42:48Z",
      pull_head_sha: "bc60b889",
    })}

## Summary

Human activity after the review snapshot must still block label sync.

${realBehaviorProofReportSection()}

${prRatingReportSection({ overallTier: "A" })}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`;
    const synced = reportWithSyncedReviewComment(sourceReport, 74483);
    writeFileSync(itemPath, synced.report, "utf8");

    const ghMock = `
const { appendFileSync, readFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const comment = ${JSON.stringify(synced.comment)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] || "";
if (args[0] === "api" && /\\/issues\\/74483$/.test(path)) {
  console.log(JSON.stringify({
    number: 74483,
    title: "Fresh head with human activity",
    html_url: "https://github.com/openclaw/openclaw/pull/74483",
    created_at: "2026-07-03T19:00:00Z",
    updated_at: "2026-07-03T21:43:45Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "contributor" },
    labels: [],
    pull_request: {}
  }));
} else if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/74483\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/74483\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/pulls\\/74483$/.test(path)) {
  console.log(JSON.stringify({
    number: 74483,
    html_url: "https://github.com/openclaw/openclaw/pull/74483",
    state: "open",
    changed_files: 1,
    commits: 2,
    review_comments: 0,
    head: { sha: "bc60b889", ref: "branch", repo: { full_name: "fork/openclaw" } },
    base: { sha: "base-sha", ref: "main", repo: { full_name: "openclaw/openclaw" } },
    user: { login: "contributor" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/74483\\/(files|commits|comments)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/74483\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[
    {
      id: 987484,
      html_url: "https://github.com/openclaw/openclaw/pull/74483#issuecomment-987484",
      body: comment,
      user: { login: "clawsweeper[bot]" },
      created_at: "2026-07-03T21:33:21Z",
      updated_at: "2026-07-03T21:33:21Z"
    },
    {
      id: 987485,
      html_url: "https://github.com/openclaw/openclaw/pull/74483#issuecomment-987485",
      body: "I already relabeled this myself, leave the labels alone.",
      user: { login: "maintainer" },
      author_association: "MEMBER",
      created_at: "2026-07-03T21:44:00Z",
      updated_at: "2026-07-03T21:44:00Z"
    }
  ]]));
} else if (args[0] === "api" && /\\/issues\\/comments\\/987484$/.test(path)) {
  const input = args[args.indexOf("--input") + 1];
  appendFileSync(logPath, JSON.stringify(["patched-review-body", JSON.parse(readFileSync(input, "utf8")).body]) + "\\n");
  console.log(JSON.stringify({
    id: 987484,
    html_url: "https://github.com/openclaw/openclaw/pull/74483#issuecomment-987484",
    updated_at: "2026-07-03T21:48:00Z"
  }));
} else if (args[0] === "issue" && args[1] === "edit") {
  console.log("");
} else if (args[0] === "label" && args[1] === "create") {
  console.log(JSON.stringify({ name: args[2] }));
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        targetRepo: "openclaw/openclaw",
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: ["--sync-comments-only", "--item-numbers", "74483"],
      });
    });

    const updatedReport = readFileSync(itemPath, "utf8");
    assert.doesNotMatch(updatedReport, /^labels_synced_at: /m);
    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(
      calls.some((args) => args[0] === "issue" && args[1] === "edit"),
      false,
    );
    assert.equal(
      calls.some((args) => args[0] === "label" && args[1] === "create"),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions withholds fresh-head PR label sync from close proposals", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    const itemPath = join(itemsDir, "74484.md");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const sourceReport = `${reportFrontMatter({
      repository: "openclaw/openclaw",
      type: "pull_request",
      number: "74484",
      title: "Fresh head close proposal",
      url: "https://github.com/openclaw/openclaw/pull/74484",
      decision: "close",
      close_reason: "low_signal_unmergeable_pr",
      confidence: "high",
      action_taken: "proposed_close",
      review_status: "complete",
      local_checkout_access: "verified",
      author: "contributor",
      author_association: "CONTRIBUTOR",
      labels: JSON.stringify([]),
      item_snapshot_hash: "snapshot-a",
      item_updated_at: "2026-07-03T21:42:48Z",
      reviewed_at: "2026-07-03T21:42:48Z",
      pull_head_sha: "bc60b889",
    })}

## Summary

A close proposal must not regain PR labels through the fresh-head allowance.

${realBehaviorProofReportSection()}

${prRatingReportSection({ overallTier: "F", proofTier: "F", patchTier: "F" })}

## Review Findings

Overall correctness: patch is incorrect

Overall confidence: 0.9

Full review comments:

- none

## Evidence

- **branch shape:** PR diff is mostly unrelated provider churn around a tiny possible useful tweak

## Close Comment

Closing this PR because the branch is not a useful landing base.
`;
    const synced = reportWithSyncedReviewComment(sourceReport, 74484, "low_signal_unmergeable_pr");
    writeFileSync(itemPath, synced.report, "utf8");

    const ghMock = `
const { appendFileSync, readFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const comment = ${JSON.stringify(synced.comment)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] || "";
if (args[0] === "api" && /\\/issues\\/74484$/.test(path)) {
  console.log(JSON.stringify({
    number: 74484,
    title: "Fresh head close proposal",
    html_url: "https://github.com/openclaw/openclaw/pull/74484",
    created_at: "2026-07-03T19:00:00Z",
    updated_at: "2026-07-03T21:43:45Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "contributor" },
    labels: [],
    pull_request: {}
  }));
} else if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/74484\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/74484\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/pulls\\/74484$/.test(path)) {
  console.log(JSON.stringify({
    number: 74484,
    html_url: "https://github.com/openclaw/openclaw/pull/74484",
    state: "open",
    changed_files: 1,
    commits: 2,
    review_comments: 0,
    requested_reviewers: [],
    requested_teams: [],
    head: { sha: "bc60b889", ref: "branch", repo: { full_name: "fork/openclaw" } },
    base: { sha: "base-sha", ref: "main", repo: { full_name: "openclaw/openclaw" } },
    user: { login: "contributor" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/74484\\/reviews(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/pulls\\/74484\\/(files|commits|comments)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/74484\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[
    {
      id: 987486,
      html_url: "https://github.com/openclaw/openclaw/pull/74484#issuecomment-987486",
      body: comment,
      user: { login: "clawsweeper[bot]" },
      created_at: "2026-07-03T21:33:21Z",
      updated_at: "2026-07-03T21:33:21Z"
    },
    {
      id: 987487,
      html_url: "https://github.com/openclaw/openclaw/pull/74484#issuecomment-987487",
      body: "Pushed a new head, please take another look.",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      created_at: "2026-07-03T21:42:28Z",
      updated_at: "2026-07-03T21:42:28Z"
    }
  ]]));
} else if (args[0] === "api" && /\\/issues\\/comments\\/987486$/.test(path)) {
  const input = args[args.indexOf("--input") + 1];
  appendFileSync(logPath, JSON.stringify(["patched-review-body", JSON.parse(readFileSync(input, "utf8")).body]) + "\\n");
  console.log(JSON.stringify({
    id: 987486,
    html_url: "https://github.com/openclaw/openclaw/pull/74484#issuecomment-987486",
    updated_at: "2026-07-03T21:48:00Z"
  }));
} else if (args[0] === "issue" && args[1] === "edit") {
  console.log("");
} else if (args[0] === "label" && args[1] === "create") {
  console.log(JSON.stringify({ name: args[2] }));
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        targetRepo: "openclaw/openclaw",
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: ["--sync-comments-only", "--item-numbers", "74484"],
      });
    });

    const updatedReport = readFileSync(itemPath, "utf8");
    assert.doesNotMatch(updatedReport, /^labels_synced_at: /m);
    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(
      calls.some(
        (args) => args[0] === "issue" && args[1] === "edit" && args.includes("--add-label"),
      ),
      false,
    );
    assert.equal(
      calls.some((args) => args[0] === "label" && args[1] === "create"),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions routes parsed security owner acceptance to maintainer review", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const labelLogPath = join(root, "label-sync.log");
    const itemPath = join(itemsDir, "74480.md");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });

    const sourceReport = `${reportFrontMatter({
      repository: "openclaw/openclaw",
      type: "pull_request",
      number: "74480",
      title: "Route owner security acceptance",
      url: "https://github.com/openclaw/openclaw/pull/74480",
      decision: "keep_open",
      close_reason: "none",
      confidence: "high",
      action_taken: "kept_open",
      review_status: "complete",
      local_checkout_access: "verified",
      author: "contributor",
      author_association: "CONTRIBUTOR",
      labels: JSON.stringify(["status: ⏳ waiting on author"]),
      item_snapshot_hash: "reviewed-snapshot",
      item_created_at: "2026-02-01T00:00:00Z",
      item_updated_at: "2026-05-01T00:00:00Z",
      pull_head_sha: "head-sha",
      merge_risk_options: JSON.stringify([
        {
          title: "Accept the reviewed security tradeoff",
          body: "A maintainer may accept this bounded security tradeoff before merge.",
          category: "accept_risk",
          recommended: true,
          automergeInstruction: "",
        },
      ]),
    })}

## Summary

The patch is correct and the remaining security decision belongs to a maintainer.

${realBehaviorProofReportSection()}

${prRatingReportSection()}

## Security Review

Status: needs_attention

Summary: A maintainer must explicitly accept the bounded security tradeoff.

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.95

Full review comments:

- none
`;
    const synced = reportWithSyncedReviewComment(sourceReport, 74480);
    writeFileSync(itemPath, synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 74480,
        title: "Route owner security acceptance",
        labels: ["status: ⏳ waiting on author"],
        comment: synced.comment,
        itemUpdatedAtAfterLabelSync: "2026-05-01T00:01:00Z",
        itemUpdatedAtAfterLabelSyncLogPath: labelLogPath,
      }),
      () => {
        runApplyDecisionsForTest({
          targetRepo: "openclaw/openclaw",
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: ["--sync-comments-only", "--item-numbers", "74480"],
        });
      },
    );

    const updatedReport = readFileSync(itemPath, "utf8");
    assert.match(updatedReport, /status: 👀 ready for maintainer look/);
    assert.doesNotMatch(updatedReport, /status: ⏳ waiting on author/);
    const labelCalls = readFileSync(labelLogPath, "utf8");
    assert.match(labelCalls, /--remove-label status: ⏳ waiting on author/);
    assert.match(labelCalls, /--add-label status: 👀 ready for maintainer look/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions refreshes recent PR comments after label sync adds justifications", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    const itemPath = join(itemsDir, "74479.md");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      itemPath,
      `${reportFrontMatter({
        repository: "openclaw/clawsweeper",
        type: "pull_request",
        number: "74479",
        title: "Refresh label explanation",
        url: "https://github.com/openclaw/clawsweeper/pull/74479",
        decision: "keep_open",
        close_reason: "none",
        confidence: "high",
        action_taken: "kept_open",
        review_status: "complete",
        local_checkout_access: "verified",
        author: "contributor",
        author_association: "CONTRIBUTOR",
        labels: JSON.stringify([]),
        item_snapshot_hash: "snapshot-a",
        item_updated_at: "2026-05-19T20:00:00Z",
        pull_head_sha: "abc123def456",
        review_comment_synced_at: "2026-05-19T23:59:00Z",
      })}

## Summary

This PR needs labels and the latest comment must explain them.

${realBehaviorProofReportSection({ evidenceKind: "screenshot" })}

${prRatingReportSection({ overallTier: "A" })}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`,
      "utf8",
    );

    const staleCommentBody =
      "Codex review: needs maintainer review before merge.\n\n<!-- clawsweeper-review item=74479 -->";
    const ghMock = `
const { appendFileSync, readFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const staleCommentBody = ${JSON.stringify(staleCommentBody)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] || "";
if (args[0] === "api" && /\\/issues\\/74479$/.test(path)) {
  console.log(JSON.stringify({
    number: 74479,
    title: "Refresh label explanation",
    html_url: "https://github.com/openclaw/clawsweeper/pull/74479",
    created_at: "2026-05-19T19:00:00Z",
    updated_at: "2026-05-19T20:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "contributor" },
    labels: [],
    pull_request: {}
  }));
} else if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/74479\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/74479\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/pulls\\/74479$/.test(path)) {
  console.log(JSON.stringify({
    number: 74479,
    html_url: "https://github.com/openclaw/clawsweeper/pull/74479",
    state: "open",
    changed_files: 1,
    commits: 1,
    review_comments: 0,
    head: { sha: "abc123def456", ref: "branch", repo: { full_name: "fork/clawsweeper" } },
    base: { sha: "base-sha", ref: "main", repo: { full_name: "openclaw/clawsweeper" } },
    user: { login: "contributor" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/74479\\/(files|commits|comments)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/74479\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[
    {
      id: 987479,
      html_url: "https://github.com/openclaw/clawsweeper/pull/74479#issuecomment-987479",
      body: staleCommentBody,
      user: { login: "clawsweeper[bot]" },
      created_at: "2026-05-19T23:59:00Z",
      updated_at: "2026-05-19T23:59:00Z"
    }
  ]]));
} else if (args[0] === "api" && /\\/issues\\/comments\\/987479$/.test(path)) {
  const input = args[args.indexOf("--input") + 1];
  appendFileSync(logPath, JSON.stringify(["patched-review-body", JSON.parse(readFileSync(input, "utf8")).body]) + "\\n");
  console.log(JSON.stringify({
    id: 987479,
    html_url: "https://github.com/openclaw/clawsweeper/pull/74479#issuecomment-987479"
  }));
} else if (args[0] === "label" && args[1] === "create") {
  console.log(JSON.stringify({ name: args[2] }));
} else if (args[0] === "issue" && args[1] === "edit") {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: [
          "--sync-comments-only",
          "--comment-sync-min-age-days",
          "7",
          "--item-numbers",
          "74479",
        ],
      });
    });

    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    const patchedBody = calls.find((args) => args[0] === "patched-review-body")?.[1] ?? "";
    assert.match(patchedBody, /Label justifications:/);
    assert.match(patchedBody, /`proof: sufficient`/);
    assert.match(patchedBody, /`proof: 📸 screenshot`/);
    assert.match(patchedBody, /`rating: 🦞 diamond lobster`/);
    assert.match(readFileSync(itemPath, "utf8"), /^labels_synced_at: /m);
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 74479,
        action: "review_comment_synced",
        reason: "updated durable Codex review comment",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions does not advisory-label close proposals before close gates finish", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const closeReport = workPlanCandidateReport({
      decision: "close",
      action_taken: "proposed_close",
      close_reason: "implemented_on_main",
      confidence: "high",
      item_snapshot_hash: "reviewed-snapshot",
      item_updated_at: "2026-05-01T00:00:00Z",
      reproduction_status: "reproduced",
      reproduction_confidence: "high",
    });
    const synced = reportWithSyncedReviewComment(closeReport, 321, "implemented_on_main");
    writeFileSync(join(itemsDir, "321.md"), synced.report, "utf8");

    const ghMock = `
const { appendFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const comment = ${JSON.stringify(synced.comment)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] || "";
if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  const timeline = Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }));
  console.log('HTTP/2 200\\nlink: <https://api.github.com/repos/openclaw/clawsweeper/issues/321/timeline?per_page=100&page=2>; rel="last"\\n\\n' + JSON.stringify(timeline));
} else if (args[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[{
    id: 9321,
    html_url: "https://github.com/openclaw/clawsweeper/issues/321#issuecomment-9321",
    created_at: "2026-05-01T01:00:00Z",
    updated_at: "2026-05-01T01:00:00Z",
    user: { login: "clawsweeper[bot]" },
    body: comment
  }]]));
} else if (args[0] === "api" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Render work plans",
    html_url: "https://github.com/openclaw/clawsweeper/issues/321",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 0,
    pull_request: null
  }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "label" || args[0] === "issue") {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: ["--apply-close-reasons", "stale_insufficient_info"],
      });
    });

    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(
      calls.some((args) => args[0] === "issue" && args[1] === "edit"),
      false,
    );
    assert.equal(
      calls.some((args) => args[0] === "label" && args[1] === "create"),
      false,
    );
    assert.equal(
      calls.some(
        (args) =>
          args[0] === "api" &&
          (args[1] ?? "").endsWith("/issues/321/timeline?per_page=100") &&
          args.includes("--paginate"),
      ),
      true,
    );
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 321,
        action: "kept_open",
        reason: "close reason implemented_on_main is not enabled for this apply run",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions posts an explicit close-time note before closing PR proposals", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    const postedBodiesPath = join(root, "posted-bodies.jsonl");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const closeReport = `${workPlanCandidateReport({
      type: "pull_request",
      decision: "close",
      action_taken: "proposed_close",
      close_reason: "implemented_on_main",
      confidence: "high",
      item_snapshot_hash: "reviewed-snapshot",
      item_updated_at: "2026-05-01T00:00:00Z",
      reproduction_status: "reproduced",
      reproduction_confidence: "high",
      fixed_pr_url: "https://github.com/openclaw/clawsweeper/pull/900",
      fixed_pr_number: "900",
      fixed_sha: "1234567890abcdef1234567890abcdef12345678",
      fixed_at: "2026-05-01T02:00:00Z",
    })}\n\n## Evidence\n\n- **main fix:** git show confirms current main has the replacement implementation and it is not in the latest release yet\n  - file: [src/clawsweeper.ts](https://github.com/openclaw/clawsweeper/blob/1234567890abcdef1234567890abcdef12345678/src/clawsweeper.ts)\n  - sha: [1234567890ab](https://github.com/openclaw/clawsweeper/commit/1234567890abcdef1234567890abcdef12345678)\n\n## Close Comment\n\nClosing this PR because the fix is already on main.\n`;
    const synced = reportWithSyncedReviewComment(closeReport, 321, "implemented_on_main");
    writeFileSync(join(itemsDir, "321.md"), synced.report, "utf8");

    const ghMock = `
const { appendFileSync, readFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const postedBodiesPath = ${JSON.stringify(postedBodiesPath)};
const comment = ${JSON.stringify(synced.comment)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] || "";
if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(path)) {
  if (args.includes("--method") && args.includes("POST")) {
    const input = args[args.indexOf("--input") + 1];
    const payload = JSON.parse(readFileSync(input, "utf8"));
    appendFileSync(postedBodiesPath, JSON.stringify(payload.body) + "\\n");
    console.log(JSON.stringify({ id: 9322, html_url: "https://github.com/openclaw/clawsweeper/pull/321#issuecomment-9322" }));
  } else {
    console.log(JSON.stringify([[{
      id: 9321,
      html_url: "https://github.com/openclaw/clawsweeper/pull/321#issuecomment-9321",
      created_at: "2026-05-01T01:00:00Z",
      updated_at: "2026-05-01T01:00:00Z",
      user: { login: "clawsweeper[bot]" },
      body: comment
    }]]));
  }
} else if (args[0] === "api" && /\\/issues\\/comments\\/9321$/.test(path)) {
  console.log(JSON.stringify({ id: 9321, html_url: "https://github.com/openclaw/clawsweeper/pull/321#issuecomment-9321" }));
} else if (args[0] === "api" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Render work plans",
    html_url: "https://github.com/openclaw/clawsweeper/pull/321",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "MEMBER",
    user: { login: "reporter" },
    labels: ["maintainer"],
    comments: 1,
    pull_request: { url: "https://api.github.com/repos/openclaw/clawsweeper/pulls/321" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    html_url: "https://github.com/openclaw/clawsweeper/pull/321",
    state: "open",
    changed_files: 0,
    commits: 0,
    review_comments: 0,
    head: { sha: "head-sha", ref: "branch", repo: { full_name: "fork/clawsweeper" } },
    base: { sha: "base-sha", ref: "main", repo: { full_name: "openclaw/clawsweeper" } },
    user: { login: "reporter" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/321\\/(files|commits|comments)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "pr" && args[1] === "close" && args[2] === "321") {
  console.log("");
} else if (args[0] === "issue" && args[1] === "edit") {
  console.log("");
} else if (args[0] === "label") {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: ["--apply-kind", "all", "--processed-limit", "2"],
      });
    });

    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    const postIndex = calls.findIndex(
      (args) =>
        args[0] === "api" &&
        (args[1] ?? "").endsWith("/issues/321/comments") &&
        args.includes("POST"),
    );
    const closeIndex = calls.findIndex(
      (args) => args[0] === "pr" && args[1] === "close" && args[2] === "321",
    );
    assert.ok(postIndex >= 0);
    assert.ok(closeIndex > postIndex);
    const postedBodies = readFileSync(postedBodiesPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string);
    assert.equal(postedBodies.length, 1);
    assert.match(postedBodies[0], /ClawSweeper applied the proposed close for this PR/);
    assert.match(postedBodies[0], /Close reason: already implemented on main/);
    assert.match(postedBodies[0], /durable ClawSweeper review/);
    assert.match(postedBodies[0], /clawsweeper-close-applied item=321/);
    assert.ok(existsSync(join(closedDir, "321.md")));
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 321,
        action: "review_comment_synced",
        reason: "updated durable Codex review comment",
      },
      {
        number: 321,
        action: "closed",
        reason: "already implemented on main; posted close-applied comment",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions keeps low-signal PRs open when live maintainer comments exist", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const closeReport = lowSignalCloseReport({ number: 322, title: "Add provider clamp" });
    const synced = reportWithSyncedReviewComment(closeReport, 322, "low_signal_unmergeable_pr");
    writeFileSync(join(itemsDir, "322.md"), synced.report, "utf8");

    const ghMock = `
const { appendFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const comment = ${JSON.stringify(synced.comment)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] || "";
if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/322\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/322\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[
    {
      id: 9322,
      html_url: "https://github.com/openclaw/clawsweeper/pull/322#issuecomment-9322",
      created_at: "2026-05-01T01:00:00Z",
      updated_at: "2026-05-01T01:00:00Z",
      author_association: "NONE",
      user: { login: "clawsweeper[bot]" },
      body: comment
    },
    {
      id: 9323,
      html_url: "https://github.com/openclaw/clawsweeper/pull/322#issuecomment-9323",
      created_at: "2026-05-01T01:30:00Z",
      updated_at: "2026-05-01T01:30:00Z",
      author_association: "MEMBER",
      user: { login: "maintainer" },
      body: "I am taking a look."
    }
  ]]));
} else if (args[0] === "api" && /\\/issues\\/322\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/322$/.test(path)) {
  console.log(JSON.stringify({
    number: 322,
    title: "Add provider clamp",
    html_url: "https://github.com/openclaw/clawsweeper/pull/322",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    assignees: [],
    comments: 2,
    pull_request: { url: "https://api.github.com/repos/openclaw/clawsweeper/pulls/322" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/322$/.test(path)) {
  console.log(JSON.stringify({
    number: 322,
    html_url: "https://github.com/openclaw/clawsweeper/pull/322",
    state: "open",
    changed_files: 4,
    commits: 1,
    review_comments: 0,
    requested_reviewers: [],
    requested_teams: [],
    head: { sha: "head-sha", ref: "branch", repo: { full_name: "fork/clawsweeper" } },
    base: { sha: "base-sha", ref: "main", repo: { full_name: "openclaw/clawsweeper" } },
    user: { login: "reporter" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/322\\/reviews(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/pulls\\/322\\/(files|commits|comments)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "issue" && args[1] === "edit") {
  console.log("");
} else if (args[0] === "label") {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        targetRepo: "openclaw/openclaw",
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: [
          "--apply-kind",
          "all",
          "--processed-limit",
          "2",
          "--apply-close-reasons",
          "low_signal_unmergeable_pr",
        ],
      });
    });

    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(
      calls.some((args) => args[0] === "pr" && args[1] === "close"),
      false,
    );
    assert.equal(existsSync(join(closedDir, "322.md")), false);
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 322,
        action: "kept_open",
        reason: "maintainer issue comment blocks low-signal auto-close",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
