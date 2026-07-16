import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  reportWithSyncedReviewComment,
  runApplyDecisionsForTest,
  tmpPrefix,
  withMockGh,
  workPlanCandidateReport,
} from "./helpers.ts";

function staleVersionReport() {
  const base = workPlanCandidateReport({
    number: 321,
    repository: "openclaw/openclaw",
    type: "issue",
    title: "Old runtime crash",
    decision: "close",
    action_taken: "proposed_close",
    close_reason: "stale_version_bug",
    confidence: "high",
    work_candidate: "none",
    work_status: "none",
    item_snapshot_hash: "reviewed-snapshot",
    item_created_at: "2026-01-01T00:00:00Z",
    item_updated_at: "2026-01-01T00:00:00Z",
    author_association: "CONTRIBUTOR",
    item_category: "bug",
  }).replace(
    "The dashboard has queue_fix_pr candidates but no generated coding plan.",
    "This report names OpenClaw 1.2 and is more than six months old; the runtime code has changed substantially since then.",
  );
  return `${base}

## Evidence

- **obsolete version:** The report names OpenClaw 1.2, while current main has replaced this runtime path.

## Close Comment

This report names OpenClaw 1.2 and is more than six months old. The runtime code has changed substantially since then. Please retest on the current release; we will reopen this issue with a fresh current-version reproduction.
`;
}

type RunOptions = {
  enabled?: boolean;
  assignees?: unknown[];
  milestone?: unknown;
  labels?: string[];
  reactions?: number;
  omitReactions?: boolean;
  createdAt?: string;
  maintainerComment?: boolean;
  recentHumanComment?: boolean;
};

function staleVersionGhMock(reviewComment: string, options: RunOptions) {
  const comments: unknown[] = [
    {
      id: 9321,
      created_at: "2026-01-01T01:00:00Z",
      updated_at: "2026-01-01T01:00:00Z",
      author_association: "NONE",
      user: { login: "clawsweeper[bot]", type: "Bot" },
      body: reviewComment,
    },
  ];
  if (options.maintainerComment) {
    comments.push({
      id: 9322,
      created_at: "2026-01-02T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      author_association: "MEMBER",
      user: { login: "maintainer", type: "User" },
      body: "I am investigating this report.",
    });
  }
  if (options.recentHumanComment) {
    comments.push({
      id: 9323,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      author_association: "NONE",
      user: { login: "reporter", type: "User" },
      body: "I can still reproduce this.",
    });
  }
  return `
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] || "";
const comments = ${JSON.stringify(comments)};
if (args[0] === "api" && path.startsWith("search/issues?")) {
  console.log(JSON.stringify({ items: [] }));
} else if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/321\\/timeline/.test(args[2] || "")) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/321\\/comments/.test(path)) {
  console.log(JSON.stringify(args.includes("--slurp") ? [comments] : comments));
} else if (args[0] === "api" && /\\/issues\\/321\\/timeline/.test(path)) {
  console.log(JSON.stringify(args.includes("--slurp") ? [[]] : []));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Old runtime crash",
    html_url: "https://github.com/openclaw/openclaw/issues/321",
    body: "OpenClaw 1.2 crashes in the old runtime path.",
    created_at: ${JSON.stringify(options.createdAt ?? "2026-01-01T00:00:00Z")},
    updated_at: "2026-01-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: ${JSON.stringify(options.labels ?? [])},
    assignees: ${JSON.stringify(options.assignees ?? [])},
    milestone: ${JSON.stringify(options.milestone ?? null)},
    reactions: ${options.omitReactions ? "undefined" : `{ total_count: ${options.reactions ?? 0} }`},
    comments: comments.length,
    pull_request: null
  }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "label" || args[0] === "issue" || (args[0] === "api" && args.includes("--method"))) {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
}

function runStaleVersionApply(options: RunOptions = {}) {
  const root = mkdtempSync(tmpPrefix);
  const previous = process.env.CLAWSWEEPER_STALE_VERSION_BUG_CLOSE_ENABLED;
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const synced = reportWithSyncedReviewComment(staleVersionReport(), 321, "stale_version_bug");
    writeFileSync(join(itemsDir, "321.md"), synced.report, "utf8");
    if (options.enabled === false) delete process.env.CLAWSWEEPER_STALE_VERSION_BUG_CLOSE_ENABLED;
    else process.env.CLAWSWEEPER_STALE_VERSION_BUG_CLOSE_ENABLED = "true";

    withMockGh(root, staleVersionGhMock(synced.comment, options), () => {
      runApplyDecisionsForTest({
        targetRepo: "openclaw/openclaw",
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: [
          "--dry-run",
          "--apply-kind",
          "issue",
          "--apply-close-reasons",
          "stale_version_bug",
          "--item-number",
          "321",
        ],
      });
    });
    return {
      entries: JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
        action: string;
        reason: string;
      }>,
      comment: synced.comment,
      closed: existsSync(join(closedDir, "321.md")),
    };
  } finally {
    if (previous === undefined) delete process.env.CLAWSWEEPER_STALE_VERSION_BUG_CLOSE_ENABLED;
    else process.env.CLAWSWEEPER_STALE_VERSION_BUG_CLOSE_ENABLED = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test("stale-version bug apply is default-off", () => {
  const result = runStaleVersionApply({ enabled: false });
  assert.equal(result.entries[0]?.action, "kept_open");
  assert.match(result.entries[0]?.reason ?? "", /policy is disabled/);
  assert.equal(result.closed, false);
});

test("stale-version bug apply closes an old inactive report", () => {
  const result = runStaleVersionApply();
  assert.equal(result.entries[0]?.action, "closed");
  assert.match(result.entries[0]?.reason ?? "", /bug report against a stale version/);
  assert.match(result.comment, /OpenClaw 1\.2/);
  assert.match(result.comment, /changed substantially/);
  assert.match(result.comment, /retest on the current release/);
  assert.match(result.comment, /will be reopened/);
});

for (const [name, options, message] of [
  ["assignee", { assignees: [{ login: "maintainer" }] }, /assigned issue/],
  ["milestone", { milestone: { title: "Next" } }, /milestoned issue/],
  ["reactions", { reactions: 20 }, /20 or more reactions/],
  ["missing reaction count", { omitReactions: true }, /reaction count is unavailable/],
  ["live age", { createdAt: "2026-07-01T00:00:00Z" }, /older than 120 days/],
  ["security label", { labels: ["topic:security-regression"] }, /security-labeled/],
  ["protected label", { labels: ["clawsweeper:human-review"] }, /protected label/],
  ["linked PR", { labels: ["clawsweeper:linked-pr-open"] }, /linked-pr-open/],
  ["maintainer comment", { maintainerComment: true }, /maintainer issue comment/],
  ["recent human comment", { recentHumanComment: true }, /last 90 days/],
] as const) {
  test(`stale-version bug apply blocks ${name}`, () => {
    const result = runStaleVersionApply(options);
    assert.equal(result.entries[0]?.action, "kept_open");
    assert.match(result.entries[0]?.reason ?? "", message);
    assert.equal(result.closed, false);
  });
}
