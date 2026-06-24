import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  implementedCloseReport,
  reportWithSyncedReviewComment,
  runApplyDecisionsForTest,
  tmpPrefix,
  withMockGh,
} from "./helpers.ts";

test("apply-decisions retries legacy fixed close skips", () => {
  for (const actionTaken of ["skipped_maintainer_authored", "skipped_invalid_decision"]) {
    const root = mkdtempSync(tmpPrefix);
    try {
      const itemsDir = join(root, "items");
      const closedDir = join(root, "closed");
      const plansDir = join(root, "plans");
      const reportPath = join(root, "apply-report.json");
      const logPath = join(root, "gh.log");
      mkdirSync(itemsDir, { recursive: true });
      mkdirSync(plansDir, { recursive: true });
      const closeReport = implementedCloseReport({
        type: "pull_request",
        action_taken: actionTaken,
        author_association: "MEMBER",
        labels: JSON.stringify(["maintainer"]),
      }).replace(
        "## Close Comment\n\nClosing this because the requested behavior is already on main.\n",
        "## Close Comment\n\n_No close comment posted._\n",
      );
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
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[{
    id: 9321,
    html_url: "https://github.com/openclaw/clawsweeper/pull/321#issuecomment-9321",
    created_at: "2026-05-01T01:00:00Z",
    updated_at: "2026-05-01T01:00:00Z",
    user: { login: "clawsweeper[bot]" },
    body: comment
  }]]));
} else if (args[0] === "api" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  if (args.includes("--method") && args.includes("PATCH")) {
    console.log(JSON.stringify({ state: "closed" }));
  } else {
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
      user: { login: "maintainer" },
      labels: ["maintainer"],
      comments: 1,
      pull_request: { url: "https://api.github.com/repos/openclaw/clawsweeper/pulls/321" }
    }));
  }
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
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
    user: { login: "maintainer" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/321\\/(files|commits|comments)(?:\\?|$)/.test(path)) {
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
          extraArgs: ["--dry-run", "--apply-kind", "all", "--processed-limit", "2"],
        });
      });

      assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
        {
          number: 321,
          action: "review_comment_synced",
          reason: "would update durable Codex review comment",
        },
        {
          number: 321,
          action: "closed",
          reason:
            "dry-run: would close as already implemented on main; dry-run: would post close-applied comment",
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("apply-decisions retries legacy kept-open close reports", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const closeReport = implementedCloseReport({
      type: "pull_request",
      action_taken: "kept_open",
    });
    const synced = reportWithSyncedReviewComment(closeReport, 321, "implemented_on_main");
    writeFileSync(join(itemsDir, "321.md"), synced.report, "utf8");

    const ghMock = `
const comment = ${JSON.stringify(synced.comment)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] || "";
if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[{
    id: 9321,
    html_url: "https://github.com/openclaw/clawsweeper/pull/321#issuecomment-9321",
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
    html_url: "https://github.com/openclaw/clawsweeper/pull/321",
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
    pull_request: { url: "https://api.github.com/repos/openclaw/clawsweeper/pulls/321" }
  }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
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
        extraArgs: ["--dry-run", "--apply-kind", "all", "--processed-limit", "2"],
      });
    });

    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 321,
        action: "review_comment_synced",
        reason: "would update durable Codex review comment",
      },
      {
        number: 321,
        action: "closed",
        reason:
          "dry-run: would close as already implemented on main; dry-run: would post close-applied comment",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions pair-closes issues blocked by closeable linked PRs", () => {
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
        title: "Issue fixed by main",
        action_taken: "skipped_open_closing_pr",
      }),
      320,
      "implemented_on_main",
    );
    const pullSynced = reportWithSyncedReviewComment(
      implementedCloseReport({
        repository: "openclaw/openclaw",
        number: 321,
        type: "pull_request",
        title: "Obsolete linked PR",
        action_taken: "kept_open",
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
    html_url: "https://github.com/openclaw/clawsweeper/issues/" + number + "#issuecomment-" + (9000 + number),
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
    title: "Issue fixed by main",
    html_url: "https://github.com/openclaw/clawsweeper/issues/320",
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
    title: "Obsolete linked PR",
    html_url: "https://github.com/openclaw/clawsweeper/pull/321",
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
    pull_request: { url: "https://api.github.com/repos/openclaw/clawsweeper/pulls/321" }
  }));
} else if (args[0] === "issue" && args[1] === "view" && args[2] === "320") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [{ number: 321 }] }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "api" && /\\/pulls\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Obsolete linked PR",
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
      reason: string;
    }>;
    assert.equal(
      report.some((entry) => entry.number === 320 && entry.action === "closed"),
      true,
    );
    assert.equal(
      report.some((entry) => entry.number === 321 && entry.action === "closed"),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
