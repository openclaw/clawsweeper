import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { renderReviewStartStatusComment } from "../dist/clawsweeper.js";

import {
  implementedCloseReport,
  lowSignalCloseReport,
  reportWithSyncedReviewComment,
  runApplyDecisionsForTest,
  tmpPrefix,
  withMockCodexProof,
  withMockGh,
} from "./helpers.ts";

test("apply-decisions starts same-author pair closes from the PR side", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const issueSynced = reportWithSyncedReviewComment(
      implementedCloseReport({
        repository: "openclaw/openclaw",
        number: 320,
        type: "issue",
        title: "Paired issue",
        author: "reporter",
        action_taken: "skipped_same_author_pair",
      }),
      320,
      "implemented_on_main",
    );
    const pullSynced = reportWithSyncedReviewComment(
      implementedCloseReport({
        repository: "openclaw/openclaw",
        number: 321,
        type: "pull_request",
        title: "Paired PR",
        author: "reporter",
        action_taken: "skipped_same_author_pair",
      }),
      321,
      "implemented_on_main",
    );
    writeFileSync(join(itemsDir, "320.md"), issueSynced.report, "utf8");
    writeFileSync(join(itemsDir, "321.md"), pullSynced.report, "utf8");

    const ghMock = `
const comments = {
  320: ${JSON.stringify(issueSynced.comment)},
  321: ${JSON.stringify(pullSynced.comment)}
};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] || "";
const issueNumber = (path.match(/\\/issues\\/(\\d+)/) || [])[1];
if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/(320|321)\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/(320|321)\\/comments(?:\\?|$)/.test(path)) {
  const number = Number(issueNumber);
  console.log(JSON.stringify([[{
    id: 9000 + number,
    html_url: "https://github.com/openclaw/openclaw/issues/" + number + "#issuecomment-" + (9000 + number),
    created_at: "2026-05-01T01:00:00Z",
    updated_at: "2026-05-01T01:00:00Z",
    user: { login: "clawsweeper[bot]" },
    body: comments[number]
  }]]));
} else if (args[0] === "api" && /\\/issues\\/(320|321)\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/320$/.test(path)) {
  console.log(JSON.stringify({
    number: 320,
    title: "Paired issue",
    html_url: "https://github.com/openclaw/openclaw/issues/320",
    body: "See #321.",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 1,
    pull_request: null
  }));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Paired PR",
    html_url: "https://github.com/openclaw/openclaw/pull/321",
    body: "Fixes #320.",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 1,
    pull_request: { url: "https://api.github.com/repos/openclaw/openclaw/pulls/321" }
  }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "api" && /\\/pulls\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Paired PR",
    html_url: "https://github.com/openclaw/openclaw/pull/321",
    state: "open",
    changed_files: 0,
    commits: 0,
    review_comments: 0,
    body: "Fixes #320.",
    head: { sha: "head-sha", ref: "branch", repo: { full_name: "fork/openclaw" } },
    base: { sha: "base-sha", ref: "main", repo: { full_name: "openclaw/openclaw" } },
    user: { login: "reporter" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/321\\/(files|commits|comments|reviews)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
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
          "--target-repo",
          "openclaw/openclaw",
          "--dry-run",
          "--apply-kind",
          "all",
          "--item-numbers",
          "321",
          "--processed-limit",
          "4",
        ],
      });
    });

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
      number: number;
      action: string;
    }>;
    assert.deepEqual(
      report.filter((entry) => entry.action === "closed").map((entry) => entry.number),
      [321, 320],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions does not start same-author pair close when PR supersession is unsafe", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const issueSynced = reportWithSyncedReviewComment(
      implementedCloseReport({
        repository: "openclaw/openclaw",
        number: 320,
        type: "issue",
        title: "Paired issue",
        author: "reporter",
        action_taken: "skipped_same_author_pair",
      }),
      320,
      "implemented_on_main",
    );
    const pullSynced = reportWithSyncedReviewComment(
      lowSignalCloseReport({
        repository: "openclaw/openclaw",
        number: 321,
        title: "Paired PR",
        author: "reporter",
        close_reason: "duplicate_or_superseded",
        action_taken: "skipped_same_author_pair",
        work_cluster_refs: JSON.stringify([
          "Superseded by https://github.com/openclaw/openclaw/pull/400",
        ]),
      }),
      321,
      "duplicate_or_superseded",
    );
    writeFileSync(join(itemsDir, "320.md"), issueSynced.report, "utf8");
    writeFileSync(join(itemsDir, "321.md"), pullSynced.report, "utf8");

    const ghMock = `
const comments = {
  320: ${JSON.stringify(issueSynced.comment)},
  321: ${JSON.stringify(pullSynced.comment)}
};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] || "";
const issueNumber = (path.match(/\\/issues\\/(\\d+)/) || [])[1];
if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/(320|321)\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/(320|321)\\/comments(?:\\?|$)/.test(path)) {
  const number = Number(issueNumber);
  console.log(JSON.stringify([[{
    id: 9000 + number,
    html_url: "https://github.com/openclaw/openclaw/issues/" + number + "#issuecomment-" + (9000 + number),
    created_at: "2026-05-01T01:00:00Z",
    updated_at: "2026-05-01T01:00:00Z",
    user: { login: "clawsweeper[bot]" },
    body: comments[number]
  }]]));
} else if (args[0] === "api" && /\\/issues\\/(320|321)\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/320$/.test(path)) {
  console.log(JSON.stringify({
    number: 320,
    title: "Paired issue",
    html_url: "https://github.com/openclaw/openclaw/issues/320",
    body: "Fixed by #321.",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 1,
    pull_request: null
  }));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Paired PR",
    html_url: "https://github.com/openclaw/openclaw/pull/321",
    body: "Fixes #320.",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 1,
    pull_request: { url: "https://api.github.com/repos/openclaw/openclaw/pulls/321" }
  }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "api" && /\\/pulls\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Paired PR",
    html_url: "https://github.com/openclaw/openclaw/pull/321",
    state: "open",
    changed_files: 1,
    commits: 1,
    review_comments: 0,
    body: "Fixes #320.",
    head: { sha: "head-sha", ref: "branch", repo: { full_name: "fork/openclaw" } },
    base: { sha: "base-sha", ref: "main", repo: { full_name: "openclaw/openclaw" } },
    user: { login: "reporter" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/400$/.test(path)) {
  console.log(JSON.stringify({
    number: 400,
    title: "Closed unmerged canonical PR",
    html_url: "https://github.com/openclaw/openclaw/pull/400",
    state: "closed",
    merged_at: null,
    labels: [{ name: "bug" }]
  }));
} else if (args[0] === "api" && /\\/pulls\\/321\\/(files|commits|comments|reviews)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
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
          "--target-repo",
          "openclaw/openclaw",
          "--dry-run",
          "--apply-kind",
          "all",
          "--processed-limit",
          "4",
        ],
      });
    });

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
      number: number;
      action: string;
    }>;
    assert.equal(
      report.some((entry) => entry.action === "closed"),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions records PR coverage proof retry before same-author pair skip", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const pullSynced = reportWithSyncedReviewComment(
      lowSignalCloseReport({
        repository: "openclaw/openclaw",
        number: 321,
        title: "Paired PR",
        author: "reporter",
        item_source_revision: "unknown",
        close_reason: "duplicate_or_superseded",
        action_taken: "proposed_close",
        work_cluster_refs: JSON.stringify([
          "Superseded by https://github.com/openclaw/openclaw/pull/400",
        ]),
      }),
      321,
      "duplicate_or_superseded",
    );
    writeFileSync(join(itemsDir, "321.md"), pullSynced.report, "utf8");

    const ghMock = `
const comments = {
  321: ${JSON.stringify(pullSynced.comment)}
};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] || "";
const issueNumber = (path.match(/\\/issues\\/(\\d+)/) || [])[1];
if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(path)) {
  const number = Number(issueNumber);
  console.log(JSON.stringify([[{
    id: 9000 + number,
    html_url: "https://github.com/openclaw/openclaw/issues/" + number + "#issuecomment-" + (9000 + number),
    created_at: "2026-05-01T01:00:00Z",
    updated_at: "2026-05-01T01:00:00Z",
    user: { login: "clawsweeper[bot]" },
    body: comments[number]
  }]]));
} else if (args[0] === "api" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/320$/.test(path)) {
  console.log(JSON.stringify({
    number: 320,
    title: "Paired issue",
    html_url: "https://github.com/openclaw/openclaw/issues/320",
    body: "Tracked by #321.",
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
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Paired PR",
    html_url: "https://github.com/openclaw/openclaw/pull/321",
    body: "Fixes #320.",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 1,
    pull_request: { url: "https://api.github.com/repos/openclaw/openclaw/pulls/321" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Paired PR",
    html_url: "https://github.com/openclaw/openclaw/pull/321",
    state: "open",
    changed_files: 1,
    commits: 1,
    review_comments: 0,
    body: "Fixes #320.",
    head: { sha: "head-sha", ref: "branch", repo: { full_name: "fork/openclaw" } },
    base: { sha: "base-sha", ref: "main", repo: { full_name: "openclaw/openclaw" } },
    user: { login: "reporter" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/400$/.test(path)) {
  console.log(JSON.stringify({
    number: 400,
    title: "Canonical provider cleanup",
    html_url: "https://github.com/openclaw/openclaw/pull/400",
    state: "open",
    merged_at: null,
    mergeable_state: "clean",
    draft: false,
    labels: [{ name: "proof: sufficient" }],
    body: "Carries the provider cleanup."
  }));
} else if (args[0] === "api" && /\\/issues\\/400$/.test(path)) {
  console.log(JSON.stringify({
    number: 400,
    title: "Canonical provider cleanup",
    html_url: "https://github.com/openclaw/openclaw/pull/400",
    body: "Carries the provider cleanup.",
    state: "open",
    labels: [{ name: "proof: sufficient" }],
    comments: 0,
    pull_request: { url: "https://api.github.com/repos/openclaw/openclaw/pulls/400" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/321\\/(files|commits|comments|reviews)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
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
      withMockCodexProof(root, { type: "failure", message: "temporary model outage" }, () => {
        runApplyDecisionsForTest({
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: [
            "--target-repo",
            "openclaw/openclaw",
            "--apply-kind",
            "all",
            "--processed-limit",
            "3",
          ],
        });
      });
    });

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
      number: number;
      action: string;
      reason: string;
    }>;
    assert.equal(
      report.find((entry) => entry.number === 321)?.action,
      "retry_pr_close_coverage_proof",
    );
    assert.equal(
      report.some((entry) => entry.action === "skipped_same_author_pair"),
      false,
    );
    assert.match(
      readFileSync(join(itemsDir, "321.md"), "utf8"),
      /^action_taken: retry_pr_close_coverage_proof$/m,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions discards exact staged labels when a same-author counterpart blocks close", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const logPath = join(root, "gh.log");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const leaseOwner = "exact-pr-321";
    const leaseCommentId = 7321;
    const headSha = "a".repeat(40);
    const reviewedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const leaseStartedAt = new Date(Date.now() - 60_000).toISOString();
    const leaseExpiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const issueSynced = reportWithSyncedReviewComment(
      implementedCloseReport({
        repository: "openclaw/openclaw",
        number: 320,
        type: "issue",
        title: "Paired issue",
        author: "reporter",
        action_taken: "skipped_same_author_pair",
      }),
      320,
      "implemented_on_main",
    );
    const pullSynced = reportWithSyncedReviewComment(
      implementedCloseReport({
        repository: "openclaw/openclaw",
        number: 321,
        type: "pull_request",
        title: "Paired PR",
        author: "reporter",
        action_taken: "skipped_same_author_pair",
        pull_head_sha: headSha,
        item_source_revision: headSha,
        review_lease_owner: leaseOwner,
        review_lease_comment_id: String(leaseCommentId),
        labels: JSON.stringify([]),
        triage_priority: "P2",
        reviewed_at: reviewedAt,
        item_updated_at: reviewedAt,
      }),
      321,
      "implemented_on_main",
    );
    writeFileSync(join(itemsDir, "320.md"), issueSynced.report, "utf8");
    writeFileSync(join(itemsDir, "321.md"), pullSynced.report, "utf8");
    const leaseComment = renderReviewStartStatusComment({
      number: 321,
      kind: "pull_request",
      title: "Paired PR",
      headSha,
      startedAt: leaseStartedAt,
      leaseExpiresAt,
      leaseOwner,
    });

    const ghMock = `
const { appendFileSync } = require("fs");
const comments = {
  320: ${JSON.stringify(issueSynced.comment)},
  321: ${JSON.stringify(pullSynced.comment)}
};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
const path = args[1] || "";
const issueNumber = (path.match(/\\/issues\\/(\\d+)/) || [])[1];
if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/(320|321)\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/(320|321)\\/comments(?:\\?|$)/.test(path)) {
  const number = Number(issueNumber);
  const reviewComments = [{
    id: 9000 + number,
    html_url: "https://github.com/openclaw/openclaw/issues/" + number + "#issuecomment-" + (9000 + number),
    created_at: ${JSON.stringify(reviewedAt)},
    updated_at: ${JSON.stringify(reviewedAt)},
    user: { login: "clawsweeper[bot]" },
    body: comments[number]
  }];
  if (number === 321) reviewComments.push({
    id: ${leaseCommentId},
    html_url: "https://github.com/openclaw/openclaw/pull/321#issuecomment-${leaseCommentId}",
    created_at: ${JSON.stringify(leaseStartedAt)},
    updated_at: ${JSON.stringify(leaseStartedAt)},
    user: { login: "clawsweeper[bot]" },
    body: ${JSON.stringify(leaseComment)}
  });
  console.log(JSON.stringify([reviewComments]));
} else if (args[0] === "api" && /\\/issues\\/(320|321)\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/320$/.test(path)) {
  console.log(JSON.stringify({
    number: 320,
    title: "Paired issue",
    html_url: "https://github.com/openclaw/openclaw/issues/320",
    body: "See #321.",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-02T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 1,
    pull_request: null
  }));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Paired PR",
    html_url: "https://github.com/openclaw/openclaw/pull/321",
    body: "Fixes #320.",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: ${JSON.stringify(reviewedAt)},
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 1,
    pull_request: { url: "https://api.github.com/repos/openclaw/openclaw/pulls/321" }
  }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "api" && /\\/pulls\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Paired PR",
    html_url: "https://github.com/openclaw/openclaw/pull/321",
    state: "open",
    changed_files: 0,
    commits: 0,
    review_comments: 0,
    body: "Fixes #320.",
    head: { sha: ${JSON.stringify(headSha)}, ref: "branch", repo: { full_name: "fork/openclaw" } },
    base: { sha: "base-sha", ref: "main", repo: { full_name: "openclaw/openclaw" } },
    user: { login: "reporter" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/321\\/(files|commits|comments|reviews)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/comments\\/${leaseCommentId}$/.test(path) && args.includes("DELETE")) {
  console.log("");
} else if (args[0] === "label" && args[1] === "list") {
  console.log(JSON.stringify([]));
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
          "--target-repo",
          "openclaw/openclaw",
          "--apply-kind",
          "all",
          "--exact-event-publication",
          "--item-numbers",
          "321",
          "--processed-limit",
          "1",
          "--event-apply-proof",
        ],
      });
    });

    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 321,
        action: "skipped_same_author_pair",
        reason: "open issue #320 (Paired issue) by the same author is paired with this PR",
        guardedOpenStateVerified: true,
        terminalPolicyNoopVerified: true,
      },
    ]);
    const updatedReport = readFileSync(join(itemsDir, "321.md"), "utf8");
    assert.match(updatedReport, /^labels: \[\]$/m);
    assert.doesNotMatch(updatedReport, /^labels_synced_at: /m);
    const commands = readFileSync(logPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(
      commands.some((args) => args[0] === "issue" && args[1] === "edit"),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions keeps same-author PR blocked when counterpart needs a maintainer decision", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const issueSynced = reportWithSyncedReviewComment(
      implementedCloseReport({
        repository: "openclaw/openclaw",
        number: 320,
        type: "issue",
        title: "Paired issue",
        author: "reporter",
        action_taken: "skipped_same_author_pair",
        maintainer_decision: JSON.stringify({
          required: true,
          kind: "product_direction",
          question: "Should this issue be closed with its paired PR?",
          rationale: "Closing the pair would settle a product contract that maintainers must own.",
          options: [
            {
              title: "Keep the pair open",
              body: "Retain both items until the product contract is decided.",
              recommended: true,
            },
            {
              title: "Close the pair",
              body: "Accept the proposed contract and close both items.",
              recommended: false,
            },
          ],
          likelyOwner: {
            person: "@owner",
            reason: "Recent history identifies this maintainer as the contract owner.",
            confidence: "high",
          },
        }),
      }),
      320,
      "implemented_on_main",
    );
    const pullSynced = reportWithSyncedReviewComment(
      implementedCloseReport({
        repository: "openclaw/openclaw",
        number: 321,
        type: "pull_request",
        title: "Paired PR",
        author: "reporter",
        action_taken: "skipped_same_author_pair",
      }),
      321,
      "implemented_on_main",
    );
    writeFileSync(join(itemsDir, "320.md"), issueSynced.report, "utf8");
    writeFileSync(join(itemsDir, "321.md"), pullSynced.report, "utf8");

    const ghMock = `
const issueComment = ${JSON.stringify(issueSynced.comment)};
const pullComment = ${JSON.stringify(pullSynced.comment)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] || "";
if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/(320|321)\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/320\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[{
    id: 9320,
    html_url: "https://github.com/openclaw/openclaw/issues/320#issuecomment-9320",
    created_at: "2026-05-01T01:00:00Z",
    updated_at: "2026-05-01T01:00:00Z",
    user: { login: "clawsweeper[bot]" },
    body: issueComment
  }]]));
} else if (args[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[{
    id: 9321,
    html_url: "https://github.com/openclaw/openclaw/issues/321#issuecomment-9321",
    created_at: "2026-05-01T01:00:00Z",
    updated_at: "2026-05-01T01:00:00Z",
    user: { login: "clawsweeper[bot]" },
    body: pullComment
  }]]));
} else if (args[0] === "api" && /\\/issues\\/(320|321)\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/320$/.test(path)) {
  console.log(JSON.stringify({
    number: 320,
    title: "Paired issue",
    html_url: "https://github.com/openclaw/openclaw/issues/320",
    body: "See #321.",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 1,
    pull_request: null
  }));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Paired PR",
    html_url: "https://github.com/openclaw/openclaw/pull/321",
    body: "Fixes #320.",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 1,
    pull_request: { url: "https://api.github.com/repos/openclaw/openclaw/pulls/321" }
  }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "api" && /\\/pulls\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Paired PR",
    html_url: "https://github.com/openclaw/openclaw/pull/321",
    state: "open",
    changed_files: 0,
    commits: 0,
    review_comments: 0,
    body: "Fixes #320.",
    head: { sha: "head-sha", ref: "branch", repo: { full_name: "fork/openclaw" } },
    base: { sha: "base-sha", ref: "main", repo: { full_name: "openclaw/openclaw" } },
    user: { login: "reporter" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/321\\/(files|commits|comments|reviews)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
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
          "--target-repo",
          "openclaw/openclaw",
          "--dry-run",
          "--apply-kind",
          "all",
          "--processed-limit",
          "1",
        ],
      });
    });

    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 321,
        action: "skipped_same_author_pair",
        reason: "open issue #320 (Paired issue) by the same author is paired with this PR",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions keeps same-author PR blocked when counterpart reason is disabled", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const issueSynced = reportWithSyncedReviewComment(
      implementedCloseReport({
        repository: "openclaw/openclaw",
        number: 320,
        type: "issue",
        title: "Paired issue",
        author: "reporter",
        action_taken: "skipped_same_author_pair",
      }),
      320,
      "implemented_on_main",
    );
    const pullSynced = reportWithSyncedReviewComment(
      implementedCloseReport({
        repository: "openclaw/openclaw",
        number: 321,
        type: "pull_request",
        title: "Paired duplicate PR",
        author: "reporter",
        action_taken: "skipped_same_author_pair",
        close_reason: "duplicate_or_superseded",
      }),
      321,
      "duplicate_or_superseded",
    );
    writeFileSync(join(itemsDir, "320.md"), issueSynced.report, "utf8");
    writeFileSync(join(itemsDir, "321.md"), pullSynced.report, "utf8");

    const ghMock = `
const comments = {
  320: ${JSON.stringify(issueSynced.comment)},
  321: ${JSON.stringify(pullSynced.comment)}
};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] || "";
const issueNumber = (path.match(/\\/issues\\/(\\d+)/) || [])[1];
if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/(320|321)\\/comments(?:\\?|$)/.test(path)) {
  const number = Number(issueNumber);
  console.log(JSON.stringify([[{
    id: 9000 + number,
    html_url: "https://github.com/openclaw/openclaw/issues/" + number + "#issuecomment-" + (9000 + number),
    created_at: "2026-05-01T01:00:00Z",
    updated_at: "2026-05-01T01:00:00Z",
    user: { login: "clawsweeper[bot]" },
    body: comments[number]
  }]]));
} else if (args[0] === "api" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/320$/.test(path)) {
  console.log(JSON.stringify({
    number: 320,
    title: "Paired issue",
    html_url: "https://github.com/openclaw/openclaw/issues/320",
    body: "See #321.",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 1,
    pull_request: null
  }));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Paired duplicate PR",
    html_url: "https://github.com/openclaw/openclaw/pull/321",
    body: "Fixes #320.",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: 1,
    pull_request: { url: "https://api.github.com/repos/openclaw/openclaw/pulls/321" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Paired duplicate PR",
    html_url: "https://github.com/openclaw/openclaw/pull/321",
    state: "open",
    changed_files: 0,
    commits: 0,
    review_comments: 0,
    body: "Fixes #320.",
    head: { sha: "head-sha", ref: "branch", repo: { full_name: "fork/openclaw" } },
    base: { sha: "base-sha", ref: "main", repo: { full_name: "openclaw/openclaw" } },
    user: { login: "reporter" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/321\\/(files|commits|comments|reviews)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
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
          "--target-repo",
          "openclaw/openclaw",
          "--dry-run",
          "--apply-kind",
          "all",
          "--apply-close-reasons",
          "duplicate_or_superseded",
          "--processed-limit",
          "1",
        ],
      });
    });

    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 321,
        action: "skipped_same_author_pair",
        reason: "open issue #320 (Paired issue) by the same author is paired with this PR",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
