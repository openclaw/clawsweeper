import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  contextHasNonAutomationActivityAfterForTest,
  isExactEventSourceRevisionChange,
  itemSourceRevisionSha256ForTest,
  renderReviewStartStatusComment,
} from "../dist/clawsweeper.js";

import {
  implementedCloseReport,
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

test("complete activity hydration distinguishes truncation from hidden human activity", () => {
  const activityAfterMs = Date.parse("2026-07-03T21:42:48Z");
  const surfaces = [
    {
      name: "comments",
      automation: { author: "fixture[bot]", createdAt: "2026-07-03T21:45:00Z" },
      human: { author: "maintainer", createdAt: "2026-07-03T21:46:00Z" },
    },
    {
      name: "timeline",
      automation: {
        event: "labeled",
        actor: "fixture[bot]",
        createdAt: "2026-07-03T21:45:00Z",
      },
      human: {
        event: "labeled",
        actor: "maintainer",
        createdAt: "2026-07-03T21:46:00Z",
      },
    },
    {
      name: "pullReviewComments",
      automation: { author: "fixture[bot]", createdAt: "2026-07-03T21:45:00Z" },
      human: { author: "maintainer", createdAt: "2026-07-03T21:46:00Z" },
    },
  ] as const;

  for (const surface of surfaces) {
    assert.equal(
      contextHasNonAutomationActivityAfterForTest({
        truncated: { [surface.name]: true },
        completeActivityContext: { [surface.name]: [surface.automation] },
        activityAfterMs,
      }),
      false,
      `${surface.name} automation-only hydration should permit reconciliation`,
    );
    assert.equal(
      contextHasNonAutomationActivityAfterForTest({
        truncated: { [surface.name]: true },
        completeActivityContext: { [surface.name]: [surface.automation, surface.human] },
        activityAfterMs,
      }),
      true,
      `${surface.name} hydration must preserve hidden human activity`,
    );
  }

  assert.equal(
    contextHasNonAutomationActivityAfterForTest({
      truncated: { comments: true },
      activityAfterMs,
    }),
    true,
    "truncation without complete hydration must remain fail closed",
  );
});

test("apply-decisions publishes a detected bulk-filer label from a failed exact review artifact", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    const number = 74486;
    const reviewedAt = new Date().toISOString();
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(itemsDir, `${number}.md`),
      `${reportFrontMatter({
        repository: "openclaw/clawsweeper",
        type: "issue",
        number: String(number),
        title: "Publish bulk-filer label",
        url: `https://github.com/openclaw/clawsweeper/issues/${number}`,
        decision: "keep_open",
        close_reason: "none",
        confidence: "high",
        action_taken: "kept_open",
        review_status: "failed",
        local_checkout_access: "verified",
        author: "contributor",
        author_association: "CONTRIBUTOR",
        labels: JSON.stringify([]),
        bulk_filer_detected: "true",
        item_snapshot_hash: "snapshot-a",
        item_updated_at: reviewedAt,
        reviewed_at: reviewedAt,
      })}

## Summary

This exact review detected a high recent filing volume before Codex failed.
`,
      "utf8",
    );
    const ghMock = `
const { appendFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] || "";
if (args[0] === "api" && /\\/issues\\/${number}$/.test(path)) {
  console.log(JSON.stringify({
    number: ${number},
    title: "Publish bulk-filer label",
    html_url: "https://github.com/openclaw/clawsweeper/issues/${number}",
    created_at: "2026-07-17T00:00:00Z",
    updated_at: ${JSON.stringify(reviewedAt)},
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "contributor" },
    labels: [],
    comments: 0,
    pull_request: null
  }));
} else if (args[0] === "api" && /\\/issues\\/${number}\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/${number}\\/comments(?:\\?|$)/.test(path)) {
  if (args.includes("--method") && args.includes("POST")) {
    console.log(JSON.stringify({
      id: 987486,
      html_url: "https://github.com/openclaw/clawsweeper/issues/${number}#issuecomment-987486"
    }));
  } else {
    console.log(JSON.stringify([[]]));
  }
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "api" && /\\/collaborators\\/contributor\\/permission$/.test(path)) {
  console.log(JSON.stringify({ permission: "read", role_name: "read" }));
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
        extraArgs: ["--sync-comments-only", "--item-numbers", String(number)],
      });
    });

    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    assert(
      calls.some(
        (args) =>
          args[0] === "label" && args[1] === "create" && args[2] === "clawsweeper:bulk-filed",
      ),
    );
    assert(
      calls.some(
        (args) =>
          args[0] === "issue" &&
          args[1] === "edit" &&
          args.includes("--add-label") &&
          args.includes("clawsweeper:bulk-filed"),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions clears a stale bulk-filer label for a redacted maintain role", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    const number = 74487;
    const reviewedAt = new Date().toISOString();
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(itemsDir, `${number}.md`),
      `${reportFrontMatter({
        repository: "openclaw/clawsweeper",
        type: "issue",
        number: String(number),
        title: "Clear stale bulk-filer label",
        url: `https://github.com/openclaw/clawsweeper/issues/${number}`,
        decision: "keep_open",
        close_reason: "none",
        confidence: "high",
        action_taken: "kept_open",
        review_status: "failed",
        local_checkout_access: "verified",
        author: "maintainer",
        author_association: "CONTRIBUTOR",
        labels: JSON.stringify(["clawsweeper:bulk-filed"]),
        bulk_filer_detected: "true",
        item_snapshot_hash: "snapshot-a",
        item_updated_at: reviewedAt,
        reviewed_at: reviewedAt,
      })}

## Summary

This exact review inherited a stale bulk-filer label.
`,
      "utf8",
    );
    const ghMock = `
const { appendFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] || "";
if (args[0] === "api" && /\\/issues\\/${number}$/.test(path)) {
  console.log(JSON.stringify({
    number: ${number},
    title: "Clear stale bulk-filer label",
    html_url: "https://github.com/openclaw/clawsweeper/issues/${number}",
    created_at: "2026-07-17T00:00:00Z",
    updated_at: ${JSON.stringify(reviewedAt)},
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "maintainer" },
    labels: ["clawsweeper:bulk-filed"],
    comments: 0,
    pull_request: null
  }));
} else if (args[0] === "api" && /\\/issues\\/${number}\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/${number}\\/comments(?:\\?|$)/.test(path)) {
  if (args.includes("--method") && args.includes("POST")) {
    console.log(JSON.stringify({
      id: 987487,
      html_url: "https://github.com/openclaw/clawsweeper/issues/${number}#issuecomment-987487"
    }));
  } else {
    console.log(JSON.stringify([[]]));
  }
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "api" && /\\/collaborators\\/maintainer\\/permission$/.test(path)) {
  console.log(JSON.stringify({ permission: "write", role_name: "maintain" }));
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
        extraArgs: ["--sync-comments-only", "--item-numbers", String(number)],
      });
    });

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
          args.includes("--remove-label") &&
          args.includes("clawsweeper:bulk-filed"),
      ),
    );
    assert.equal(
      calls.some((args) => args[0] === "label" && args[1] === "create"),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exact event source drift includes a revision change while its apply lease is held", () => {
  assert.equal(
    isExactEventSourceRevisionChange(
      "pull_request",
      "PR head changed while holding the apply mutation lease",
    ),
    true,
  );
  assert.equal(
    isExactEventSourceRevisionChange(
      "issue",
      "issue source revision changed while holding the apply mutation lease",
    ),
    true,
  );
  assert.equal(
    isExactEventSourceRevisionChange("issue", "apply mutation lease is not held"),
    false,
  );
});

test("exact publication consumes its matching completed issue review lease", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const number = 103599;
    const reviewedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const leaseUpdatedAt = new Date(Date.now() - 60_000).toISOString();
    const leaseExpiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const leaseOwner = `exact-issue-${number}`;
    const leaseCommentId = 700_000 + number;
    const issue = {
      number,
      title: `Incident issue ${number}`,
      body: "The reviewed issue source remains unchanged.",
      html_url: `https://github.com/openclaw/openclaw/issues/${number}`,
      created_at: "2026-04-01T00:00:00Z",
      updated_at: leaseUpdatedAt,
      closed_at: null,
      state: "open",
      locked: false,
      active_lock_reason: null,
      author_association: "CONTRIBUTOR",
      user: { login: "reporter" },
      labels: [],
      comments: 2,
      pull_request: null,
    };
    const sourceRevision = itemSourceRevisionSha256ForTest(issue, []);
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const closeReport = implementedCloseReport({
      repository: "openclaw/clawsweeper",
      number,
      type: "issue",
      title: issue.title,
      reviewed_at: reviewedAt,
      item_updated_at: reviewedAt,
      item_source_revision: sourceRevision,
      review_lease_owner: leaseOwner,
      review_lease_comment_id: String(leaseCommentId),
      labels: JSON.stringify([]),
    });
    const synced = reportWithSyncedReviewComment(closeReport, number, "implemented_on_main");
    writeFileSync(join(itemsDir, `${number}.md`), synced.report, "utf8");
    const leaseComment = renderReviewStartStatusComment({
      number,
      kind: "issue",
      title: issue.title,
      headSha: sourceRevision,
      startedAt: leaseUpdatedAt,
      leaseExpiresAt,
      leaseOwner,
    });
    const comments = [
      {
        id: 9000 + number,
        html_url: `https://github.com/openclaw/openclaw/issues/${number}#issuecomment-${9000 + number}`,
        created_at: reviewedAt,
        updated_at: reviewedAt,
        user: { login: "clawsweeper[bot]" },
        body: synced.comment,
      },
      {
        id: leaseCommentId,
        html_url: `https://github.com/openclaw/openclaw/issues/${number}#issuecomment-${leaseCommentId}`,
        created_at: leaseUpdatedAt,
        updated_at: leaseUpdatedAt,
        user: { login: "clawsweeper[bot]" },
        body: leaseComment,
      },
    ];
    const ghMock = `
const issue = ${JSON.stringify(issue)};
const comments = ${JSON.stringify(comments)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args.includes("-i") ? args[args.indexOf("-i") + 1] : args[1] || "";
const slurp = args.includes("--slurp");
if (args[0] === "api" && new RegExp("/issues/${number}/comments(?:\\\\?|$)").test(path)) {
  console.log(JSON.stringify(slurp ? [comments] : comments));
} else if (args[0] === "api" && new RegExp("/issues/${number}/timeline(?:\\\\?|$)").test(path)) {
  console.log(JSON.stringify(slurp ? [[]] : []));
} else if (args[0] === "api" && new RegExp("/issues/${number}$").test(path)) {
  console.log(JSON.stringify(issue));
} else if (args[0] === "api" && path.startsWith("search/issues?")) {
  console.log(JSON.stringify({ items: [] }));
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
        extraArgs: [
          "--dry-run",
          "--event-apply-proof",
          "--exact-event-publication",
          "--item-numbers",
          String(number),
          "--processed-limit",
          "2",
        ],
      });
    });

    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number,
        action: "review_comment_synced",
        reason: "would update durable Codex review comment",
        durableReviewSynced: true,
      },
      {
        number,
        action: "closed",
        reason: "dry-run: would close as already implemented on main",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("issue apply CAS blocks a newer durable review tuple published after preflight", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    const commentReadCountPath = join(root, "comment-read-count");
    const number = 74490;
    const reviewedAt = "2026-05-01T00:00:00Z";
    const newerReviewedAt = "2026-05-01T00:10:00Z";
    const issue = {
      number,
      title: "Do not apply a stale issue review",
      body: "Issue body remains unchanged while a newer exact review publishes.",
      html_url: `https://github.com/openclaw/clawsweeper/issues/${number}`,
      created_at: "2026-04-01T00:00:00Z",
      updated_at: reviewedAt,
      closed_at: null,
      state: "open",
      locked: false,
      active_lock_reason: null,
      author_association: "CONTRIBUTOR",
      user: { login: "reporter" },
      labels: [],
      comments: 1,
      pull_request: null,
    };
    const sourceRevision = itemSourceRevisionSha256ForTest(issue, []);
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });

    const oldReport = workPlanCandidateReport({
      number,
      title: issue.title,
      reviewed_at: reviewedAt,
      item_updated_at: reviewedAt,
      item_snapshot_hash: "reviewed-snapshot",
      item_source_revision: sourceRevision,
      review_lease_owner: "old-review-owner",
      review_lease_comment_id: "9100",
      labels: JSON.stringify([]),
    });
    const oldSynced = reportWithSyncedReviewComment(oldReport, number);
    writeFileSync(join(itemsDir, `${number}.md`), oldSynced.report, "utf8");

    const newerReport = workPlanCandidateReport({
      number,
      title: issue.title,
      reviewed_at: newerReviewedAt,
      item_updated_at: reviewedAt,
      item_snapshot_hash: "newer-snapshot",
      item_source_revision: sourceRevision,
      review_lease_owner: "new-review-owner",
      review_lease_comment_id: "9200",
      labels: JSON.stringify([]),
    });
    const newerComment = reportWithSyncedReviewComment(newerReport, number).comment;
    const oldLiveComment = [
      "Codex review: stale body that would be patched without the final apply CAS.",
      "",
      `<!-- clawsweeper-review item=${number} -->`,
    ].join("\n");

    const ghMock = `
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const countPath = ${JSON.stringify(commentReadCountPath)};
const issue = ${JSON.stringify(issue)};
const oldBody = ${JSON.stringify(oldLiveComment)};
const newerBody = ${JSON.stringify(newerComment)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] || "";
appendFileSync(logPath, JSON.stringify(args) + "\\n");
if (args[0] === "api" && new RegExp("/issues/${number}/comments(?:\\\\?|$)").test(path) && !args.includes("--method")) {
  const count = (existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) : 0) + 1;
  writeFileSync(countPath, String(count));
  const body = count >= 6 ? newerBody : oldBody;
  const comment = {
    id: ${9000 + number},
    html_url: "https://github.com/openclaw/clawsweeper/issues/${number}#issuecomment-${
      9000 + number
    }",
    created_at: ${JSON.stringify(reviewedAt)},
    updated_at: count >= 6 ? ${JSON.stringify(newerReviewedAt)} : ${JSON.stringify(reviewedAt)},
    user: { login: "clawsweeper[bot]" },
    body,
  };
  console.log(JSON.stringify(args.includes("--slurp") ? [[comment]] : [comment]));
} else if (args[0] === "api" && new RegExp("/issues/${number}$").test(path) && !args.includes("--method")) {
  console.log(JSON.stringify(issue));
} else if (args[0] === "api" && new RegExp("/issues/${number}/timeline(?:\\\\?|$)").test(path)) {
  console.log(JSON.stringify(args.includes("--slurp") ? [[]] : []));
} else if (args[0] === "api" && new RegExp("/issues/comments/\\\\d+$").test(path) && args.includes("--method")) {
  appendFileSync(logPath, JSON.stringify(["external-mutation", ...args]) + "\\n");
  console.log(JSON.stringify({}));
} else if (args[0] === "api" && new RegExp("/issues/${number}").test(path) && args.includes("--method")) {
  appendFileSync(logPath, JSON.stringify(["external-mutation", ...args]) + "\\n");
  console.log(JSON.stringify({}));
} else if (args[0] === "label" || args[0] === "issue" || args[0] === "pr") {
  appendFileSync(logPath, JSON.stringify(["external-mutation", ...args]) + "\\n");
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
        extraArgs: ["--item-numbers", String(number), "--comment-sync-min-age-days", "0"],
      });
    });

    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    assert.ok(Number(readFileSync(commentReadCountPath, "utf8")) >= 6);
    assert.equal(
      calls.some((args) => args[0] === "external-mutation"),
      false,
    );
    assert.equal(existsSync(join(closedDir, `${number}.md`)), false);
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number,
        action: "skipped_stale_review_comment_sync",
        reason:
          "live durable review tuple is newer than the local report: comment lease=9200, report lease=9100",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("issue apply rejects a stable live source revision that differs from the report", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    const number = 74492;
    const reviewedAt = "2026-05-01T00:00:00Z";
    const liveIssue = {
      number,
      title: "Changed after review",
      body: "Live body edited after the report was created.",
      html_url: `https://github.com/openclaw/clawsweeper/issues/${number}`,
      created_at: "2026-04-01T00:00:00Z",
      updated_at: "2026-05-01T00:10:00Z",
      closed_at: null,
      state: "open",
      locked: false,
      active_lock_reason: null,
      author_association: "CONTRIBUTOR",
      user: { login: "reporter" },
      labels: [],
      comments: 0,
      pull_request: null,
    };
    const reviewedIssue = { ...liveIssue, body: "Body at review time.", updated_at: reviewedAt };
    const reviewedRevision = itemSourceRevisionSha256ForTest(reviewedIssue, []);
    const liveRevision = itemSourceRevisionSha256ForTest(liveIssue, []);
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(itemsDir, `${number}.md`),
      workPlanCandidateReport({
        number,
        title: liveIssue.title,
        reviewed_at: reviewedAt,
        item_updated_at: reviewedAt,
        item_snapshot_hash: "reviewed-snapshot",
        item_source_revision: reviewedRevision,
        review_lease_owner: "review-owner",
        review_lease_comment_id: "9100",
        labels: JSON.stringify([]),
      }),
      "utf8",
    );

    const ghMock = `
const { appendFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const issue = ${JSON.stringify(liveIssue)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] || "";
appendFileSync(logPath, JSON.stringify(args) + "\\n");
if (args[0] === "api" && new RegExp("/issues/${number}/comments(?:\\\\?|$)").test(path) && !args.includes("--method")) {
  console.log(JSON.stringify(args.includes("--slurp") ? [[]] : []));
} else if (args[0] === "api" && new RegExp("/issues/${number}$").test(path) && !args.includes("--method")) {
  console.log(JSON.stringify(issue));
} else if (args[0] === "api" && new RegExp("/issues/${number}/timeline(?:\\\\?|$)").test(path)) {
  console.log(JSON.stringify(args.includes("--slurp") ? [[]] : []));
} else if (args.includes("--method") || ["issue", "pr", "label"].includes(args[0])) {
  appendFileSync(logPath, JSON.stringify(["external-mutation", ...args]) + "\\n");
  console.log(JSON.stringify({}));
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
        extraArgs: ["--item-numbers", String(number)],
      });
    });

    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(
      calls.some((args) => args[0] === "external-mutation"),
      false,
    );
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number,
        action: "kept_open",
        reason: `live issue source revision ${liveRevision} differs from reviewed revision ${reviewedRevision}`,
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("issue apply preserves an owned active review lease for the live source revision", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    const number = 74491;
    const reviewedAt = "2026-05-01T00:00:00Z";
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const issue = {
      number,
      title: "Keep broad apply out of an exact issue review",
      body: "Issue source remains stable during review.",
      html_url: `https://github.com/openclaw/clawsweeper/issues/${number}`,
      created_at: "2026-04-01T00:00:00Z",
      updated_at: reviewedAt,
      closed_at: null,
      state: "open",
      locked: false,
      active_lock_reason: null,
      author_association: "CONTRIBUTOR",
      user: { login: "reporter" },
      labels: [],
      comments: 2,
      pull_request: null,
    };
    const sourceRevision = itemSourceRevisionSha256ForTest(issue, []);
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const report = workPlanCandidateReport({
      number,
      title: issue.title,
      reviewed_at: reviewedAt,
      item_updated_at: reviewedAt,
      item_snapshot_hash: "reviewed-snapshot",
      item_source_revision: sourceRevision,
      review_lease_owner: "previous-review-owner",
      review_lease_comment_id: "9100",
      labels: JSON.stringify([]),
    });
    const synced = reportWithSyncedReviewComment(report, number);
    writeFileSync(join(itemsDir, `${number}.md`), synced.report, "utf8");
    const activeLease = renderReviewStartStatusComment({
      number,
      kind: "issue",
      title: issue.title,
      headSha: sourceRevision,
      startedAt,
      leaseExpiresAt: expiresAt,
      leaseOwner: "active-issue-review-owner",
    });
    const comments = [
      {
        id: 9000 + number,
        html_url: `https://github.com/openclaw/clawsweeper/issues/${number}#issuecomment-${
          9000 + number
        }`,
        created_at: reviewedAt,
        updated_at: reviewedAt,
        user: { login: "clawsweeper[bot]" },
        body: synced.comment,
      },
      {
        id: 9300,
        html_url: `https://github.com/openclaw/clawsweeper/issues/${number}#issuecomment-9300`,
        created_at: startedAt,
        updated_at: startedAt,
        user: { login: "clawsweeper[bot]" },
        body: activeLease,
      },
    ];
    const ghMock = `
const { appendFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const issue = ${JSON.stringify(issue)};
const comments = ${JSON.stringify(comments)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] || "";
appendFileSync(logPath, JSON.stringify(args) + "\\n");
if (args[0] === "api" && new RegExp("/issues/${number}/comments(?:\\\\?|$)").test(path) && !args.includes("--method")) {
  console.log(JSON.stringify(args.includes("--slurp") ? [comments] : comments));
} else if (args[0] === "api" && new RegExp("/issues/${number}$").test(path) && !args.includes("--method")) {
  console.log(JSON.stringify(issue));
} else if (args[0] === "api" && args.includes("--method")) {
  appendFileSync(logPath, JSON.stringify(["external-mutation", ...args]) + "\\n");
  console.log(JSON.stringify({}));
} else if (args[0] === "label" || args[0] === "issue" || args[0] === "pr") {
  appendFileSync(logPath, JSON.stringify(["external-mutation", ...args]) + "\\n");
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
        extraArgs: ["--item-numbers", String(number), "--comment-sync-min-age-days", "0"],
      });
    });
    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(
      calls.some((args) => args[0] === "external-mutation"),
      false,
    );
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number,
        action: "kept_open",
        reason: `same-revision ClawSweeper review is active until ${expiresAt}`,
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exact issue apply accepts its report-owned lease update after stable source proof", () => {
  for (const number of [103599, 103690]) {
    const root = mkdtempSync(tmpPrefix);
    try {
      const itemsDir = join(root, "items");
      const closedDir = join(root, "closed");
      const plansDir = join(root, "plans");
      const reportPath = join(root, "apply-report.json");
      const reviewedAt = new Date(Date.now() - 5 * 60_000).toISOString();
      const leaseUpdatedAt = new Date(Date.now() - 60_000).toISOString();
      const leaseExpiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
      const leaseOwner = `exact-issue-${number}`;
      const leaseCommentId = 700_000 + number;
      const issue = {
        number,
        title: `Incident issue ${number}`,
        body: "The reviewed issue source remains unchanged.",
        html_url: `https://github.com/openclaw/openclaw/issues/${number}`,
        created_at: "2026-04-01T00:00:00Z",
        updated_at: leaseUpdatedAt,
        closed_at: null,
        state: "open",
        locked: false,
        active_lock_reason: null,
        author_association: "CONTRIBUTOR",
        user: { login: "reporter" },
        labels: [],
        comments: 2,
        pull_request: null,
      };
      const sourceRevision = itemSourceRevisionSha256ForTest(issue, []);
      mkdirSync(itemsDir, { recursive: true });
      mkdirSync(plansDir, { recursive: true });
      const closeReport = implementedCloseReport({
        repository: "openclaw/clawsweeper",
        number,
        type: "issue",
        title: issue.title,
        reviewed_at: reviewedAt,
        item_updated_at: reviewedAt,
        item_source_revision: sourceRevision,
        review_lease_owner: leaseOwner,
        review_lease_comment_id: String(leaseCommentId),
        labels: JSON.stringify([]),
      });
      const synced = reportWithSyncedReviewComment(closeReport, number, "implemented_on_main");
      writeFileSync(join(itemsDir, `${number}.md`), synced.report, "utf8");
      const leaseComment = renderReviewStartStatusComment({
        number,
        kind: "issue",
        title: issue.title,
        headSha: sourceRevision,
        startedAt: leaseUpdatedAt,
        leaseExpiresAt,
        leaseOwner,
      });
      const comments = [
        {
          id: 9000 + number,
          html_url: `https://github.com/openclaw/openclaw/issues/${number}#issuecomment-${
            9000 + number
          }`,
          created_at: reviewedAt,
          updated_at: reviewedAt,
          user: { login: "clawsweeper[bot]" },
          body: synced.comment,
        },
        {
          id: leaseCommentId,
          html_url: `https://github.com/openclaw/openclaw/issues/${number}#issuecomment-${leaseCommentId}`,
          created_at: leaseUpdatedAt,
          updated_at: leaseUpdatedAt,
          user: { login: "clawsweeper[bot]" },
          body: leaseComment,
        },
      ];

      const ghMock = `
const issue = ${JSON.stringify(issue)};
const comments = ${JSON.stringify(comments)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args.includes("-i") ? args[args.indexOf("-i") + 1] : args[1] || "";
const slurp = args.includes("--slurp");
if (args[0] === "api" && new RegExp("/issues/${number}/comments(?:\\\\?|$)").test(path)) {
  console.log(JSON.stringify(slurp ? [comments] : comments));
} else if (args[0] === "api" && new RegExp("/issues/${number}/timeline(?:\\\\?|$)").test(path)) {
  console.log(JSON.stringify(slurp ? [[]] : []));
} else if (args[0] === "api" && new RegExp("/issues/${number}$").test(path)) {
  console.log(JSON.stringify(issue));
} else if (args[0] === "api" && path.startsWith("search/issues?")) {
  console.log(JSON.stringify({ items: [] }));
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
          extraArgs: [
            "--dry-run",
            "--event-apply-proof",
            "--item-numbers",
            String(number),
            "--processed-limit",
            "2",
          ],
        });
      });

      assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
        {
          number,
          action: "review_comment_synced",
          reason: "would update durable Codex review comment",
          durableReviewSynced: true,
        },
        {
          number,
          action: "closed",
          reason: "dry-run: would close as already implemented on main",
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("apply-decisions rejects a changed close report even when an expired lease is newest", () => {
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
  console.log(JSON.stringify([[
    {
      id: 9001,
      created_at: "2026-05-02T00:00:00Z",
      updated_at: "2026-05-02T00:00:00Z",
      user: { login: "contributor" },
      body: "This changed the issue after the reviewed close decision."
    },
    {
      id: 9002,
      created_at: "2026-05-03T00:00:00Z",
      updated_at: "2026-05-03T00:00:00Z",
      user: { login: "clawsweeper[bot]" },
      body: [
        "ClawSweeper status: review started.",
        "",
        "<!-- clawsweeper-review-status:started item=321 sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa started_at=2026-05-02T00:00:00Z lease_expires_at=2026-05-02T01:00:00Z owner=abandoned-review v=1 -->",
        "",
        "<!-- clawsweeper-review-lease item=321 -->"
      ].join("\\n")
    }
  ]]));
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
      runApplyDecisionsForTest({
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: ["--event-apply-proof"],
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
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 321,
        action: "skipped_changed_since_review",
        reason: "updated_at changed",
        sourceDriftVerified: true,
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
} else if (args[0] === "api" && /\\/pulls\\/74478\\/(files|commits|comments|reviews)(?:\\?|$)/.test(path)) {
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
      "good first issue",
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
    const newerStaleHeadComment = synced.comment.replace(
      /\breviewed_at=[^\s>]+/,
      "reviewed_at=2026-05-20T00:00:00.000Z",
    );

    const ghMock = `
const { appendFileSync, readFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const comment = ${JSON.stringify(newerStaleHeadComment)};
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
} else if (args[0] === "api" && /\\/pulls\\/74481\\/(files|commits|comments|reviews)(?:\\?|$)/.test(path)) {
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
      /- reviewed 2026-05-20T00:00:00\.000Z sha old-head :: needs maintainer review before merge\./,
    );
    assert.doesNotMatch(patchedBody, /clawsweeper-verdict:/);
    const updatedReport = readFileSync(itemPath, "utf8");
    assert.match(updatedReport, /^current_pull_head_sha: new-head$/m);
    assert.match(updatedReport, /^labels: \["P2","good first issue"\]$/m);
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

test("apply-decisions skips stale label cleanup when the durable review comment is newer", () => {
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
    const readyLabel = "status: \u{1F440} ready for maintainer look";
    const mergeRiskLabel = "merge-risk: \u{1F6A8} message-delivery";
    const staleLabels = [
      "P1",
      "rating: \u{1F99E} diamond lobster",
      mergeRiskLabel,
      readyLabel,
      "proof: sufficient",
    ];
    writeFileSync(
      itemPath,
      `${reportFrontMatter({
        repository: "openclaw/openclaw",
        type: "pull_request",
        number: "74483",
        title: "Stale report with newer durable comment",
        url: "https://github.com/openclaw/openclaw/pull/74483",
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
        reviewed_at: "2026-05-19T20:00:00.000Z",
        pull_head_sha: "old-head",
        merge_risk_labels: JSON.stringify([mergeRiskLabel]),
      })}

## Summary

This stored report is stale because a later review already updated the durable comment.

${realBehaviorProofReportSection()}

${prRatingReportSection({ overallTier: "A", proofTier: "A", patchTier: "A" })}

## Review Findings

Overall correctness: patch is correct

Overall confidence: 0.9

Full review comments:

- none
`,
      "utf8",
    );

    const newerComment = [
      "Codex review: needs maintainer review before merge.",
      "",
      "<!-- clawsweeper-verdict:needs-human item=74483 sha=new-head confidence=high updated_at=2026-05-19T20:10:00Z reviewed_at=2026-05-20T00:00:00.000Z source_revision=new-source -->",
      "<!-- clawsweeper-review item=74483 -->",
    ].join("\n");
    const ghMock = `
const { appendFileSync, readFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const newerComment = ${JSON.stringify(newerComment)};
const staleLabels = ${JSON.stringify(staleLabels)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] || "";
if (args[0] === "api" && /\\/issues\\/74483$/.test(path)) {
  console.log(JSON.stringify({
    number: 74483,
    title: "Stale report with newer durable comment",
    html_url: "https://github.com/openclaw/openclaw/pull/74483",
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
    head: { sha: "new-head", ref: "branch", repo: { full_name: "fork/openclaw" } },
    base: { sha: "base-sha", ref: "main", repo: { full_name: "openclaw/openclaw" } },
    user: { login: "contributor" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/74483\\/(files|commits|comments|reviews)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/74483\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[
    {
      id: 987483,
      html_url: "https://github.com/openclaw/openclaw/pull/74483#issuecomment-987483",
      body: newerComment,
      user: { login: "clawsweeper[bot]" },
      created_at: "2026-05-20T00:00:00Z",
      updated_at: "2026-05-20T00:00:00Z"
    }
  ]]));
} else if (args[0] === "api" && /\\/issues\\/comments\\/987483$/.test(path)) {
  const input = args[args.indexOf("--input") + 1];
  appendFileSync(logPath, JSON.stringify(["patched-review-body", JSON.parse(readFileSync(input, "utf8")).body]) + "\\n");
  console.log(JSON.stringify({
    id: 987483,
    html_url: "https://github.com/openclaw/openclaw/pull/74483#issuecomment-987483",
    updated_at: "2026-05-20T00:01:00Z"
  }));
} else if (args[0] === "issue" && args[1] === "edit") {
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
        extraArgs: ["--sync-comments-only", "--item-numbers", "74483"],
      });
    });

    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(
      calls.filter((args) => args[0] === "issue" && args[1] === "edit"),
      [],
    );
    assert.equal(
      calls.some((args) => args[0] === "patched-review-body"),
      false,
    );
    const updatedReport = readFileSync(itemPath, "utf8");
    assert.ok(updatedReport.includes(`labels: ${JSON.stringify(staleLabels)}`));
    const result = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
      number: number;
      action: string;
      reason: string;
    }>;
    assert.equal(result[0]?.number, 74483);
    assert.equal(result[0]?.action, "skipped_stale_review_comment_sync");
    assert.match(
      result[0]?.reason ?? "",
      /live durable review comment is newer than the local report/,
    );
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
const comments = [
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
  },
  ...Array.from({ length: 22 }, (_, index) => ({
    id: 987500 + index,
    html_url: "https://github.com/openclaw/openclaw/pull/74482#issuecomment-" + (987500 + index),
    body: "automation update " + (index + 1),
    user: { login: "fixture[bot]" },
    created_at: "2026-07-03T21:45:00Z",
    updated_at: "2026-07-03T21:45:00Z"
  }))
];
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
    comments: comments.length,
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
} else if (args[0] === "api" && /\\/pulls\\/74482\\/(files|commits|comments|reviews)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/74482\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify(args.includes("--paginate") ? [comments] : comments));
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
const automationComments = Array.from({ length: 23 }, (_, index) => ({
  id: 987500 + index,
  html_url: "https://github.com/openclaw/openclaw/pull/74483#issuecomment-" + (987500 + index),
  body: "automation update " + (index + 1),
  user: { login: "fixture[bot]" },
  created_at: "2026-07-03T21:45:00Z",
  updated_at: "2026-07-03T21:45:00Z"
}));
const comments = [
  {
    id: 987484,
    html_url: "https://github.com/openclaw/openclaw/pull/74483#issuecomment-987484",
    body: comment,
    user: { login: "clawsweeper[bot]" },
    created_at: "2026-07-03T21:33:21Z",
    updated_at: "2026-07-03T21:33:21Z"
  },
  ...automationComments.slice(0, 11),
  {
    id: 987485,
    html_url: "https://github.com/openclaw/openclaw/pull/74483#issuecomment-987485",
    body: "I already relabeled this myself, leave the labels alone.",
    user: { login: "maintainer" },
    author_association: "MEMBER",
    created_at: "2026-07-03T21:44:00Z",
    updated_at: "2026-07-03T21:44:00Z"
  },
  ...automationComments.slice(11)
];
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
    comments: comments.length,
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
} else if (args[0] === "api" && /\\/pulls\\/74483\\/(files|commits|comments|reviews)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/74483\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify(args.includes("--paginate") ? [comments] : comments));
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
} else if (args[0] === "api" && /\\/pulls\\/74484\\/(files|commits|comments|reviews)(?:\\?|$)/.test(path)) {
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
} else if (args[0] === "api" && /\\/pulls\\/74479\\/(files|commits|comments|reviews)(?:\\?|$)/.test(path)) {
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

test("apply preserves an in-flight exact-head review lease and defers old report actions", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const number = 74486;
    const headSha = "0123456789abcdef0123456789abcdef01234567";
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });

    const closeReport = lowSignalCloseReport({
      number,
      title: "Do not apply an old verdict during re-review",
      pull_head_sha: headSha,
      reviewed_at: "2026-05-01T00:00:00Z",
      labels: JSON.stringify(["clawsweeper:autofix"]),
    });
    const synced = reportWithSyncedReviewComment(closeReport, number, "low_signal_unmergeable_pr");
    writeFileSync(join(itemsDir, `${number}.md`), synced.report, "utf8");

    const activeComment = [
      "ClawSweeper status: review started.",
      "",
      `<!-- clawsweeper-review-status:started item=${number} sha=${headSha} started_at=${startedAt} lease_expires_at=${expiresAt} v=1 -->`,
      "",
      `<!-- clawsweeper-review-lease item=${number} -->`,
    ].join("\n");
    const commentRecord = (id: number, body: string) => ({
      id,
      html_url: `https://github.com/openclaw/openclaw/pull/${number}#issuecomment-${id}`,
      created_at: startedAt,
      updated_at: startedAt,
      user: { login: "clawsweeper[bot]" },
      body,
    });
    const ghMock = promotionGhMock({
      number,
      title: "Do not apply an old verdict during re-review",
      headSha,
      labels: ["clawsweeper:autofix"],
      comment: synced.comment,
      comments: [
        commentRecord(9000 + number, synced.comment),
        commentRecord(10000 + number, activeComment),
      ],
    });

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
          "--apply-close-reasons",
          "low_signal_unmergeable_pr",
          "--item-numbers",
          String(number),
        ],
      });
    });

    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number,
        action: "kept_open",
        reason: `same-head ClawSweeper review is active until ${expiresAt}`,
      },
    ]);
    assert.equal(existsSync(join(closedDir, `${number}.md`)), false);
    assert.equal(existsSync(join(root, `comment-state-${number}.json`)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lease published during durable comment sync survives the write and blocks close", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const number = 74489;
    const headSha = "0123456789abcdef0123456789abcdef01234567";
    const startedAt = new Date(Date.now() - 30_000).toISOString();
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });

    const closeReport = lowSignalCloseReport({
      number,
      title: "Do not erase a lease while syncing the old verdict",
      pull_head_sha: headSha,
      reviewed_at: "2026-05-01T00:00:00Z",
    });
    const synced = reportWithSyncedReviewComment(closeReport, number, "low_signal_unmergeable_pr");
    writeFileSync(join(itemsDir, `${number}.md`), synced.report, "utf8");

    const staleDurableComment = [
      "Codex review: stale body that apply will replace.",
      "",
      `<!-- clawsweeper-review item=${number} -->`,
    ].join("\n");
    const activeLeaseComment = [
      "ClawSweeper status: review started.",
      "",
      `<!-- clawsweeper-review-status:started item=${number} sha=${headSha} started_at=${startedAt} lease_expires_at=${expiresAt} v=1 -->`,
      "",
      `<!-- clawsweeper-review-lease item=${number} -->`,
    ].join("\n");
    const commentRecord = (id: number, body: string) => ({
      id,
      html_url: `https://github.com/openclaw/openclaw/pull/${number}#issuecomment-${id}`,
      created_at: startedAt,
      updated_at: startedAt,
      user: { login: "clawsweeper[bot]" },
      body,
    });
    const durable = commentRecord(9000 + number, staleDurableComment);
    const lease = commentRecord(10000 + number, activeLeaseComment);

    withMockGh(
      root,
      promotionGhMock({
        number,
        title: "Do not erase a lease while syncing the old verdict",
        headSha,
        comment: staleDurableComment,
        comments: [durable],
        commentsAfterCommentWrite: [durable, lease],
      }),
      () => {
        runApplyDecisionsForTest({
          targetRepo: "openclaw/openclaw",
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: [
            "--apply-kind",
            "all",
            "--apply-close-reasons",
            "low_signal_unmergeable_pr",
            "--item-numbers",
            String(number),
          ],
        });
      },
    );

    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number,
        action: "review_comment_synced",
        reason: "updated durable Codex review comment",
      },
    ]);
    const writtenDurable = JSON.parse(
      readFileSync(join(root, `comment-state-${number}.json`), "utf8"),
    );
    assert.doesNotMatch(writtenDurable.body, /clawsweeper-review-status:started/);

    withMockGh(
      root,
      promotionGhMock({
        number,
        title: "Do not erase a lease while syncing the old verdict",
        headSha,
        comment: staleDurableComment,
        comments: [durable],
        commentsAfterCommentWrite: [durable, lease],
      }),
      () => {
        runApplyDecisionsForTest({
          targetRepo: "openclaw/openclaw",
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: [
            "--apply-kind",
            "all",
            "--apply-close-reasons",
            "low_signal_unmergeable_pr",
            "--item-numbers",
            String(number),
          ],
        });
      },
    );

    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number,
        action: "kept_open",
        reason: `same-head ClawSweeper review is active until ${expiresAt}`,
      },
    ]);
    assert.equal(existsSync(join(closedDir, `${number}.md`)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply defers incomplete old report actions when a same-head review finishes mid-run", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const number = 74488;
    const headSha = "0123456789abcdef0123456789abcdef01234567";
    const oldReviewedAt = "2026-05-01T00:00:00Z";
    const newReviewedAt = new Date().toISOString();
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });

    const closeReport = lowSignalCloseReport({
      number,
      title: "Do not apply an old verdict after re-review finishes",
      pull_head_sha: headSha,
      reviewed_at: oldReviewedAt,
    });
    const synced = reportWithSyncedReviewComment(closeReport, number, "low_signal_unmergeable_pr");
    const newerComment = synced.comment.replaceAll(
      `reviewed_at=${oldReviewedAt}`,
      `reviewed_at=${newReviewedAt}`,
    );
    assert.notEqual(newerComment, synced.comment);
    const commentRecord = (body: string) => ({
      id: 9000 + number,
      html_url: `https://github.com/openclaw/openclaw/pull/${number}#issuecomment-${9000 + number}`,
      created_at: oldReviewedAt,
      updated_at: newReviewedAt,
      user: { login: "clawsweeper[bot]" },
      body,
    });
    const itemPath = join(itemsDir, `${number}.md`);
    const incompleteReport = synced.report
      .replace(/^reviewed_at:.*\n/m, "")
      .replace(/^pull_head_sha:.*\n/m, "");
    assert.notEqual(incompleteReport, synced.report);
    writeFileSync(itemPath, incompleteReport, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number,
        title: "Do not apply an old verdict after re-review finishes",
        headSha,
        comment: synced.comment,
        comments: [commentRecord(synced.comment)],
        commentsAfterFirstRead: [commentRecord(newerComment)],
      }),
      () => {
        runApplyDecisionsForTest({
          targetRepo: "openclaw/openclaw",
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: [
            "--apply-kind",
            "all",
            "--apply-close-reasons",
            "low_signal_unmergeable_pr",
            "--item-numbers",
            String(number),
          ],
        });
      },
    );

    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number,
        action: "skipped_stale_review_comment_sync",
        reason: `live durable review comment is newer than the local report: comment reviewed_at=${newReviewedAt}, report reviewed_at=missing; comment head=${headSha}, report head=missing`,
      },
    ]);
    assert.equal(existsSync(join(closedDir, `${number}.md`)), false);
    assert.equal(existsSync(join(root, `comment-state-${number}.json`)), false);
    assert.match(readFileSync(itemPath, "utf8"), /^action_taken: proposed_close$/m);
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
} else if (args[0] === "api" && /\\/pulls\\/321\\/(files|commits|comments|reviews)(?:\\?|$)/.test(path)) {
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
} else if (args[0] === "api" && /\\/pulls\\/322\\/(files|commits|comments|reviews)(?:\\?|$)/.test(path)) {
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
        action: "skipped_low_signal_live_guard",
        reason: "maintainer issue comment blocks low-signal auto-close",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
