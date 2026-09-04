import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  contextHasNonAutomationActivityAfterForTest,
  implementedOnMainCloseProvenanceBlock,
  isExactEventSourceRevisionChange,
  itemSourceRevisionSha256ForTest,
  renderReviewStartStatusComment,
} from "../dist/clawsweeper.js";
import { createReviewCommentPublication } from "../dist/clawsweeper-review-comment-publication.js";

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

function createApplyDirectories(root: string) {
  const itemsDir = join(root, "items");
  const closedDir = join(root, "closed");
  const plansDir = join(root, "plans");
  const reportPath = join(root, "apply-report.json");
  mkdirSync(itemsDir, { recursive: true });
  mkdirSync(plansDir, { recursive: true });
  return { itemsDir, closedDir, plansDir, reportPath };
}

test("apply-time implementation provenance keeps incomplete PR closeout metadata open", () => {
  const incomplete = `repository: openclaw/openclaw
fixed_pr_url: unknown
fixed_pr_number: unknown
fixed_pr_confidence: unknown
fixed_pr_source: unknown
fixed_pr_merged_at: unknown`;
  assert.equal(
    implementedOnMainCloseProvenanceBlock(
      incomplete,
      "pull_request",
      118679,
      "implemented_on_main",
    ),
    "implemented-on-main close requires a GitHub-verified, same-repository merged fixing pull request",
  );

  const verified = `repository: openclaw/openclaw
fixed_pr_url: https://github.com/openclaw/openclaw/pull/456
fixed_pr_number: 456
fixed_pr_confidence: high
fixed_pr_source: GitHub linked-issue closing PR reference
fixed_pr_merged_at: 2026-08-18T12:00:00Z`;
  assert.equal(
    implementedOnMainCloseProvenanceBlock(verified, "pull_request", 118679, "implemented_on_main"),
    null,
  );
  assert.equal(
    implementedOnMainCloseProvenanceBlock(verified, "pull_request", 456, "implemented_on_main"),
    "implemented-on-main close requires a GitHub-verified, same-repository merged fixing pull request",
  );
});

test("same-item comment payloads never overwrite an earlier pending mutation", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const publication = createReviewCommentPublication({
      root,
      ensureDir: (directory: string) => mkdirSync(directory, { recursive: true }),
    } as Parameters<typeof createReviewCommentPublication>[0]);

    const firstBody = "ClawSweeper applied the proposed close for this PR.";
    const secondBody = "A concurrent worker published a different durable review.";
    const firstPayload = publication.writeCommentPayload(321, firstBody);
    const secondPayload = publication.writeCommentPayload(321, secondBody);

    assert.notEqual(firstPayload, secondPayload);
    assert.deepEqual(JSON.parse(readFileSync(firstPayload, "utf8")), { body: firstBody });
    assert.deepEqual(JSON.parse(readFileSync(secondPayload, "utf8")), { body: secondBody });
    assert.equal(readFileSync(firstPayload.replace(/\.json$/, ".md"), "utf8"), firstBody);
    assert.equal(readFileSync(secondPayload.replace(/\.json$/, ".md"), "utf8"), secondBody);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("closeout receipts ignore spoofed markers after posting the owned receipt", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const comments: Record<string, unknown>[] = [
      {
        id: 1,
        user: { login: "contributor" },
        body: "<!-- clawsweeper-close-applied item=321 -->",
      },
    ];
    let mutationCount = 0;
    const publication = createReviewCommentPublication({
      root,
      targetRepo: () => "openclaw/clawsweeper",
      ghPaged: () => comments,
      asRecord: (value: unknown) => value as Record<string, unknown>,
      ensureDir: (directory: string) => mkdirSync(directory, { recursive: true }),
      sha256: () => "body-digest",
      ghObservedMutationCommand: ({ args }) => {
        mutationCount += 1;
        const input = args[args.indexOf("--input") + 1];
        const body = JSON.parse(readFileSync(input!, "utf8")).body as string;
        comments.push({ id: 2, user: { login: "clawsweeper[bot]" }, body });
        return JSON.stringify({ id: 2 });
      },
      frontMatterValue: () => undefined,
      replaceFrontMatterValue: (markdown: string) => markdown,
      sectionValue: () => "",
      timestampMs: () => null,
      sentence: (value: string) => value,
      normalizedLabelSet: () => new Set<string>(),
      sectionLineValue: () => undefined,
      markdownLink: (label: string, url: string) => `[${label}](${url})`,
      closeAppliedCommentMarker: (number: number) =>
        `<!-- clawsweeper-close-applied item=${number} -->`,
      commentId: (comment: Record<string, unknown> | undefined) =>
        typeof comment?.id === "number" ? comment.id : null,
      canPatchReviewComment: (comment: Record<string, unknown> | undefined) =>
        (comment?.user as { login?: unknown } | undefined)?.login === "clawsweeper[bot]",
    } as Parameters<typeof createReviewCommentPublication>[0]);
    const options = {
      number: 321,
      closeReason: "implemented_on_main" as const,
      markdown: "",
      itemUrl: "https://github.com/openclaw/clawsweeper/pull/321",
      dryRun: false,
    };
    comments[0]!.body = publication.renderCloseAppliedComment(options);

    assert.equal(publication.ensureCloseAppliedComment(options), "posted close-applied comment");
    assert.equal(
      publication.ensureCloseAppliedComment(options),
      "matching ClawSweeper close-applied comment already exists",
    );
    assert.equal(mutationCount, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("partial label-sync authentication failures preserve labels already applied", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const { itemsDir, closedDir, plansDir, reportPath } = createApplyDirectories(root);
    const labelState = join(root, "labels.json");
    writeFileSync(labelState, "[]");
    const synced = reportWithSyncedReviewComment(
      workPlanCandidateReport({
        number: 321,
        reviewed_at: "2026-05-01T00:00:00Z",
        item_snapshot_hash: "reviewed-snapshot-321",
        item_updated_at: "2026-05-01T00:00:00Z",
        triage_priority: "P2",
        impact_labels: JSON.stringify(["impact:message-loss"]),
      }),
      321,
    );
    const itemPath = join(itemsDir, "321.md");
    writeFileSync(itemPath, synced.report);
    const ghMock = `
const { readFileSync, writeFileSync } = require("fs");
const args = process.argv.slice(2);
const actual = args[0] === "--repo" ? args.slice(2) : args;
const path = actual[1] || "";
const stateFile = ${JSON.stringify(labelState)};
const labels = () => JSON.parse(readFileSync(stateFile, "utf8"));
if (actual[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[{ id: 9321, html_url: "https://github.com/openclaw/clawsweeper/issues/321#issuecomment-9321", created_at: "2026-05-01T01:00:00Z", updated_at: "2026-05-01T01:00:00Z", user: { login: "clawsweeper[bot]" }, body: ${JSON.stringify(synced.comment)} }]]));
} else if (actual[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({ number: 321, title: "Render work plans", html_url: "https://github.com/openclaw/clawsweeper/issues/321", created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-01T00:00:00Z", closed_at: null, state: "open", locked: false, active_lock_reason: null, author_association: "CONTRIBUTOR", user: { login: "reporter" }, labels: labels().map(name => ({ name })), pull_request: null }));
} else if (actual[0] === "issue" && actual[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (actual[0] === "label" && actual[1] === "create") {
  console.log("");
} else if (actual[0] === "issue" && actual[1] === "edit" && actual.includes("P2")) {
  writeFileSync(stateFile, JSON.stringify(["P2"]));
  console.log("");
} else if (actual[0] === "issue" && actual[1] === "edit" && actual.includes("impact:message-loss")) {
  console.error("HTTP 401: Requires authentication");
  process.exit(1);
} else {
  console.error("unexpected gh args", JSON.stringify(actual));
  process.exit(1);
}`;
    withMockGh(root, ghMock, () =>
      runApplyDecisionsForTest({
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: ["--skip-dashboard", "--item-number", "321"],
      }),
    );
    assert.deepEqual(
      JSON.parse(readFileSync(labelState, "utf8")),
      ["P2"],
      readFileSync(reportPath, "utf8"),
    );
    assert.match(readFileSync(itemPath, "utf8"), /^labels:.*P2/m);
    assert.match(readFileSync(reportPath, "utf8"), /Requires authentication/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lost mutation lease preserves labels already applied", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const { itemsDir, closedDir, plansDir, reportPath } = createApplyDirectories(root);
    const statePath = join(root, "state.json");
    const number = 321;
    const reviewedAt = new Date(Date.now() - 180_000).toISOString();
    const startedAt = new Date(Date.now() - 120_000).toISOString();
    const expiresAt = new Date(Date.now() + 1_800_000).toISOString();
    const leaseOwner = "report-owned-review";
    const leaseId = 700_321;
    const issue = {
      number,
      title: "Preserve label state across a lease race",
      body: "Reviewed source.",
      html_url: "https://github.com/openclaw/clawsweeper/issues/321",
      created_at: "2026-05-01T00:00:00Z",
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
    const synced = reportWithSyncedReviewComment(
      workPlanCandidateReport({
        number,
        repository: "openclaw/clawsweeper",
        type: "issue",
        title: issue.title,
        reviewed_at: reviewedAt,
        item_snapshot_hash: "reviewed-snapshot-321",
        item_updated_at: reviewedAt,
        item_source_revision: sourceRevision,
        review_lease_owner: leaseOwner,
        review_lease_comment_id: String(leaseId),
        labels: JSON.stringify([]),
        triage_priority: "P2",
        impact_labels: JSON.stringify(["impact:message-loss"]),
      }),
      number,
    );
    const itemPath = join(itemsDir, "321.md");
    writeFileSync(itemPath, synced.report);
    writeFileSync(statePath, JSON.stringify({ labels: [], leaseActive: true }));
    const durable = {
      id: 9321,
      html_url: "https://github.com/openclaw/clawsweeper/issues/321#issuecomment-9321",
      created_at: reviewedAt,
      updated_at: reviewedAt,
      user: { login: "clawsweeper[bot]" },
      body: synced.comment,
    };
    const lease = {
      id: leaseId,
      html_url: "https://github.com/openclaw/clawsweeper/issues/321#issuecomment-700321",
      created_at: startedAt,
      updated_at: startedAt,
      user: { login: "clawsweeper[bot]" },
      body: renderReviewStartStatusComment({
        number,
        kind: "issue",
        title: issue.title,
        headSha: sourceRevision,
        startedAt,
        leaseExpiresAt: expiresAt,
        leaseOwner,
      }),
    };
    const ghMock = `
const { readFileSync, writeFileSync } = require("fs");
const args = process.argv.slice(2);
const actual = args[0] === "--repo" ? args.slice(2) : args;
const path = actual.includes("-i") ? actual[actual.indexOf("-i") + 1] : actual[1] || "";
const statePath = ${JSON.stringify(statePath)};
const state = () => JSON.parse(readFileSync(statePath));
const durable = ${JSON.stringify(durable)};
const lease = ${JSON.stringify(lease)};
const issue = ${JSON.stringify(issue)};
if (actual[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(path) && !actual.includes("--method")) {
  const comments = state().leaseActive ? [durable, lease] : [durable];
  console.log(JSON.stringify(actual.includes("--slurp") ? [comments] : comments));
} else if (actual[0] === "api" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify(actual.includes("--slurp") ? [[]] : []));
} else if (actual[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({ ...issue, labels: state().labels }));
} else if (actual[0] === "issue" && actual[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (actual[0] === "label" && actual[1] === "create") {
  console.log("");
} else if (actual[0] === "issue" && actual[1] === "edit" && actual.includes("P2")) {
  writeFileSync(statePath, JSON.stringify({ labels: ["P2"], leaseActive: false }));
  console.log("");
} else if (actual[0] === "api" && /\\/issues\\/comments\\/\\d+$/.test(path) && actual.includes("--method")) {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(actual));
  process.exit(1);
}`;
    withMockGh(root, ghMock, () =>
      runApplyDecisionsForTest({
        targetRepo: "openclaw/clawsweeper",
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: ["--skip-dashboard", "--item-number", "321"],
      }),
    );
    assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")).labels, ["P2"]);
    assert.match(readFileSync(itemPath, "utf8"), /^labels:.*P2/m);
    assert.match(readFileSync(reportPath, "utf8"), /no longer the elected same-revision lease/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
    const { itemsDir, closedDir, plansDir, reportPath } = createApplyDirectories(root);
    const logPath = join(root, "gh.log");
    const number = 74486;
    const reviewedAt = new Date().toISOString();
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
const { appendFileSync, readFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] === "-i" ? args[2] || "" : args[1] || "";
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
    const input = args[args.indexOf("--input") + 1];
    const body = JSON.parse(readFileSync(input, "utf8")).body;
    console.log(JSON.stringify({
      id: 987486,
      html_url: "https://github.com/openclaw/clawsweeper/issues/${number}#issuecomment-987486",
      user: { login: "clawsweeper[bot]" },
      body
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
    const { itemsDir, closedDir, plansDir, reportPath } = createApplyDirectories(root);
    const logPath = join(root, "gh.log");
    const number = 74487;
    const reviewedAt = new Date().toISOString();
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
const { appendFileSync, readFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] === "-i" ? args[2] || "" : args[1] || "";
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
    const input = args[args.indexOf("--input") + 1];
    const body = JSON.parse(readFileSync(input, "utf8")).body;
    console.log(JSON.stringify({
      id: 987487,
      html_url: "https://github.com/openclaw/clawsweeper/issues/${number}#issuecomment-987487",
      user: { login: "clawsweeper[bot]" },
      body
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

function assertCompletedIssueLeaseAccepted(extraArgs: string[]): void {
  const root = mkdtempSync(tmpPrefix);
  try {
    const { itemsDir, closedDir, plansDir, reportPath } = createApplyDirectories(root);
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
          ...extraArgs,
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

test("exact publication consumes its matching completed issue review lease", () => {
  assertCompletedIssueLeaseAccepted(["--exact-event-publication"]);
});

test("exact issue apply accepts its report-owned lease update after stable source proof", () => {
  assertCompletedIssueLeaseAccepted([]);
});

test("exact publication rechecks after batched labels and again before close", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const { itemsDir, closedDir, plansDir, reportPath } = createApplyDirectories(root);
    const statePath = join(root, "state.json");
    const logPath = join(root, "gh.log");
    const number = 103701;
    const reviewedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const leaseUpdatedAt = new Date(Date.now() - 60_000).toISOString();
    const leaseExpiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const leaseOwner = `exact-issue-${number}`;
    const leaseCommentId = 700_000 + number;
    const supersededLeaseCommentId = leaseCommentId - 1;
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
      labels: ["clawsweeper-recovery-stuck"],
      comments: 3,
      pull_request: null,
    };
    const sourceRevision = itemSourceRevisionSha256ForTest(issue, []);
    const closeReport = implementedCloseReport({
      repository: "openclaw/openclaw",
      number,
      type: "issue",
      title: issue.title,
      reviewed_at: reviewedAt,
      item_updated_at: reviewedAt,
      item_source_revision: sourceRevision,
      review_lease_owner: leaseOwner,
      review_lease_comment_id: String(leaseCommentId),
      labels: JSON.stringify(["clawsweeper-recovery-stuck"]),
      triage_priority: "P2",
      impact_labels: JSON.stringify(["impact:message-loss"]),
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
    const supersededLeaseComment = renderReviewStartStatusComment({
      number,
      kind: "issue",
      title: issue.title,
      headSha: sourceRevision,
      startedAt: new Date(Date.now() - 15 * 60_000).toISOString(),
      leaseExpiresAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      leaseOwner: `superseded-${leaseOwner}`,
    });
    const durableCommentId = 9000 + number;
    writeFileSync(
      statePath,
      JSON.stringify({
        labels: ["clawsweeper-recovery-stuck"],
        state: "open",
        comments: [
          {
            id: durableCommentId,
            html_url: `${issue.html_url}#issuecomment-${durableCommentId}`,
            created_at: reviewedAt,
            updated_at: reviewedAt,
            user: { login: "clawsweeper[bot]" },
            body: `${synced.comment}\n\nPrior publication body.`,
          },
          {
            id: leaseCommentId,
            html_url: `${issue.html_url}#issuecomment-${leaseCommentId}`,
            created_at: leaseUpdatedAt,
            updated_at: leaseUpdatedAt,
            user: { login: "clawsweeper[bot]" },
            body: leaseComment,
          },
          {
            id: supersededLeaseCommentId,
            html_url: `${issue.html_url}#issuecomment-${supersededLeaseCommentId}`,
            created_at: new Date(Date.now() - 15 * 60_000).toISOString(),
            updated_at: new Date(Date.now() - 15 * 60_000).toISOString(),
            user: { login: "clawsweeper[bot]" },
            body: supersededLeaseComment,
          },
        ],
      }),
      "utf8",
    );

    const ghMock = `
const { appendFileSync, readFileSync, writeFileSync } = require("fs");
const issue = ${JSON.stringify(issue)};
const statePath = ${JSON.stringify(statePath)};
const logPath = ${JSON.stringify(logPath)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args.includes("-i") ? args[args.indexOf("-i") + 1] : args[1] || "";
const slurp = args.includes("--slurp");
const readState = () => JSON.parse(readFileSync(statePath, "utf8"));
const saveState = value => writeFileSync(statePath, JSON.stringify(value));
if (args[0] === "api" && new RegExp("/issues/comments/\\\\d+$").test(path) && args.includes("--method")) {
  const state = readState();
  const id = Number(path.match(/\\d+$/)[0]);
  if (args[args.indexOf("--method") + 1] === "DELETE") {
    state.comments = state.comments.filter(comment => comment.id !== id);
    saveState(state);
    console.log("");
  } else {
    const payload = JSON.parse(readFileSync(args[args.indexOf("--input") + 1], "utf8"));
    const comment = state.comments.find(candidate => candidate.id === id);
    comment.body = payload.body;
    comment.updated_at = new Date().toISOString();
    saveState(state);
    console.log(JSON.stringify(comment));
  }
} else if (args[0] === "api" && new RegExp("/issues/${number}/comments(?:\\\\?|$)").test(path)) {
  const comments = readState().comments;
  console.log(JSON.stringify(slurp ? [comments] : comments));
} else if (args[0] === "api" && new RegExp("/issues/${number}/timeline(?:\\\\?|$)").test(path)) {
  console.log(JSON.stringify(slurp ? [[]] : []));
} else if (args[0] === "api" && new RegExp("/issues/${number}$").test(path)) {
  const state = readState();
  if (args.includes("--method")) {
    state.state = "closed";
    saveState(state);
  }
  console.log(JSON.stringify({ ...issue, state: state.state, labels: state.labels }));
} else if (args[0] === "api" && path.startsWith("search/issues?")) {
  console.log(JSON.stringify({ items: [] }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "label" && args[1] === "list") {
  console.log(JSON.stringify([
    { name: "P2", color: "FBCA04", description: "Important but bounded work with a practical workaround or moderate scope." },
    { name: "impact:message-loss", color: "D93F0B", description: "This issue is about lost, duplicated, misrouted, or suppressed channel messages." }
  ]));
} else if (args[0] === "label" && args[1] === "create") {
  console.log("");
} else if (args[0] === "issue" && args[1] === "edit") {
  const state = readState();
  const additions = args.includes("--add-label") ? args[args.indexOf("--add-label") + 1].split(",") : [];
  const removals = args.includes("--remove-label") ? args[args.indexOf("--remove-label") + 1].split(",") : [];
  state.labels = [...new Set([...state.labels.filter(label => !removals.includes(label)), ...additions])];
  saveState(state);
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
          "--event-apply-proof",
          "--exact-event-publication",
          "--item-numbers",
          String(number),
          "--processed-limit",
          "2",
        ],
      });
    });

    const commands = readFileSync(logPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as string[]);
    const labelCommands = commands.filter(
      (args) => args[0] === "issue" && args[1] === "edit" && args[2] === String(number),
    );
    assert.equal(labelCommands.length, 1);
    assert.ok(
      labelCommands[0]?.includes("P2") || labelCommands[0]?.some((arg) => arg.includes("P2")),
    );
    assert.ok(labelCommands[0]?.some((arg) => arg.includes("impact:message-loss")));

    const labelIndex = commands.indexOf(labelCommands[0] as string[]);
    const commentIndex = commands.findIndex(
      (args) =>
        args[0] === "api" &&
        args[1]?.endsWith(`/issues/comments/${durableCommentId}`) &&
        args.includes("PATCH"),
    );
    const closeIndex = commands.findIndex(
      (args) =>
        args[0] === "api" && args[1]?.endsWith(`/issues/${number}`) && args.includes("PATCH"),
    );
    const ownedLeaseReleaseIndex = commands.findIndex(
      (args) =>
        args[0] === "api" &&
        args[1]?.endsWith(`/issues/comments/${leaseCommentId}`) &&
        args.includes("DELETE"),
    );
    assert.ok(
      commentIndex >= 0 &&
        labelIndex > commentIndex &&
        closeIndex > labelIndex &&
        ownedLeaseReleaseIndex > closeIndex,
      JSON.stringify({ commands, report: JSON.parse(readFileSync(reportPath, "utf8")) }),
    );
    const isGuardRead = (args: string[]): boolean =>
      args[0] === "api" &&
      !args.includes("--method") &&
      (args[1]?.includes(`/issues/${number}`) ?? false);
    assert.ok(
      commands.slice(commentIndex + 1, labelIndex).some(isGuardRead),
      `expected a fresh label guard after comment publication: ${JSON.stringify(
        commands.slice(commentIndex + 1, labelIndex),
      )}`,
    );
    assert.ok(
      commands.slice(closeIndex + 1, ownedLeaseReleaseIndex).some(isGuardRead),
      `expected an ownership read before releasing the active lease: ${JSON.stringify(
        commands.slice(closeIndex + 1, ownedLeaseReleaseIndex),
      )}`,
    );
    assert.equal(
      commands.some(
        (args) =>
          args[0] === "api" &&
          args[1]?.endsWith(`/issues/comments/${supersededLeaseCommentId}`) &&
          args.includes("DELETE"),
      ),
      false,
      "publication must not sweep another lease",
    );
    const postCommentIssueReads = commands
      .slice(commentIndex + 1, closeIndex)
      .filter((args) => isGuardRead(args) && args[1]?.endsWith(`/issues/${number}`));
    assert.ok(
      postCommentIssueReads.length >= 2,
      `expected a fresh close guard after the post-publication receipt: ${JSON.stringify(postCommentIssueReads)}`,
    );
    assert.equal(readFileSync(statePath, "utf8").includes('"state":"closed"'), true);
    assert.equal(
      (JSON.parse(readFileSync(statePath, "utf8")).labels as string[]).includes(
        "clawsweeper-recovery-stuck",
      ),
      false,
    );
    assert.match(readFileSync(join(closedDir, `${number}.md`), "utf8"), /^labels_synced_at: /m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exact metadata-only publication flushes recoverable labels and drops failed optional additions", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const { itemsDir, closedDir, plansDir, reportPath } = createApplyDirectories(root);
    const statePath = join(root, "state.json");
    const logPath = join(root, "gh.log");
    const patchedCommentPath = join(root, "patched-comment.md");
    const number = 103702;
    const reviewedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const leaseUpdatedAt = new Date(Date.now() - 60_000).toISOString();
    const leaseExpiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const leaseOwner = `exact-issue-${number}`;
    const leaseCommentId = 700_000 + number;
    const issue = {
      number,
      title: `Metadata-only publication ${number}`,
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
      labels: ["P1"],
      comments: 2,
      pull_request: null,
    };
    const sourceRevision = itemSourceRevisionSha256ForTest(issue, []);
    const sourceReport = workPlanCandidateReport({
      repository: "openclaw/openclaw",
      number,
      title: issue.title,
      reviewed_at: reviewedAt,
      item_updated_at: reviewedAt,
      item_snapshot_hash: "reviewed-snapshot",
      item_source_revision: sourceRevision,
      review_lease_owner: leaseOwner,
      review_lease_comment_id: String(leaseCommentId),
      labels: JSON.stringify(["P1"]),
      triage_priority: "P2",
    });
    const synced = reportWithSyncedReviewComment(sourceReport, number);
    const metadataOnlyReport = synced.report.replace(/^review_comment_id:.*\n/m, "");
    writeFileSync(join(itemsDir, `${number}.md`), metadataOnlyReport, "utf8");
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
        html_url: `${issue.html_url}#issuecomment-${9000 + number}`,
        created_at: reviewedAt,
        updated_at: reviewedAt,
        user: { login: "clawsweeper[bot]" },
        body: synced.comment,
      },
      {
        id: leaseCommentId,
        html_url: `${issue.html_url}#issuecomment-${leaseCommentId}`,
        created_at: leaseUpdatedAt,
        updated_at: leaseUpdatedAt,
        user: { login: "clawsweeper[bot]" },
        body: leaseComment,
      },
    ];
    writeFileSync(statePath, JSON.stringify({ labels: ["P1"], updatedAt: leaseUpdatedAt }), "utf8");

    const ghMock = `
const { appendFileSync, readFileSync, writeFileSync } = require("fs");
const issue = ${JSON.stringify(issue)};
const comments = ${JSON.stringify(comments)};
const statePath = ${JSON.stringify(statePath)};
const logPath = ${JSON.stringify(logPath)};
const patchedCommentPath = ${JSON.stringify(patchedCommentPath)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args.includes("-i") ? args[args.indexOf("-i") + 1] : args[1] || "";
const slurp = args.includes("--slurp");
if (args[0] === "api" && new RegExp("/issues/${number}/comments(?:\\\\?|$)").test(path)) {
  console.log(JSON.stringify(slurp ? [comments] : comments));
} else if (args[0] === "api" && new RegExp("/issues/${number}/timeline(?:\\\\?|$)").test(path)) {
  console.log(JSON.stringify(slurp ? [[]] : []));
} else if (args[0] === "api" && new RegExp("/issues/${number}$").test(path)) {
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  console.log(JSON.stringify({
    ...issue,
    updated_at: state.updatedAt,
    labels: state.labels,
  }));
} else if (args[0] === "api" && path.startsWith("search/issues?")) {
  console.log(JSON.stringify({ items: [] }));
} else if (args[0] === "api" && new RegExp("/issues/comments/\\\\d+$").test(path) && args.includes("PATCH")) {
  const payloadPath = args[args.indexOf("--input") + 1];
  const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
  writeFileSync(patchedCommentPath, payload.body, "utf8");
  console.log(JSON.stringify({ ...comments[0], body: payload.body }));
} else if (args[0] === "api" && new RegExp("/issues/comments/\\\\d+$").test(path) && args.includes("DELETE")) {
  console.log("");
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "label" && args[1] === "list") {
  console.log(JSON.stringify([
    { name: "P2", color: "FBCA04", description: "Important but bounded work with a practical workaround or moderate scope." }
  ]));
} else if (args[0] === "label" && args[1] === "create") {
  console.log("");
} else if (args[0] === "issue" && args[1] === "edit") {
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const additions = args.includes("--add-label") ? args[args.indexOf("--add-label") + 1].split(",") : [];
  const removals = args.includes("--remove-label") ? args[args.indexOf("--remove-label") + 1].split(",") : [];
  state.labels = state.labels.filter(name => !removals.includes(name));
  state.updatedAt = new Date(Date.parse(state.updatedAt) + 1000).toISOString();
  if (additions.length > 1 || additions[0] === "P2") {
    writeFileSync(statePath, JSON.stringify(state));
    console.error("labels can have a maximum of 100 labels");
    process.exit(1);
  }
  state.labels = [...new Set([...state.labels, ...additions])];
  writeFileSync(statePath, JSON.stringify(state));
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
          "--sync-comments-only",
          "--event-apply-proof",
          "--exact-event-publication",
          "--item-numbers",
          String(number),
        ],
      });
    });

    const commands = readFileSync(logPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as string[]);
    const publishedLabels = JSON.parse(readFileSync(statePath, "utf8")).labels as string[];
    assert.ok(publishedLabels.length > 0, JSON.stringify(commands));
    assert.equal(publishedLabels.includes("P2"), false);
    assert.ok(commands.filter((args) => args[0] === "issue" && args[1] === "edit").length > 1);
    const lastDefinitionIndex = commands.findLastIndex(
      (args) => args[0] === "label" && args[1] === "create",
    );
    const itemLabelIndex = commands.findIndex((args) => args[0] === "issue" && args[1] === "edit");
    assert.ok(lastDefinitionIndex >= 0 && itemLabelIndex > lastDefinitionIndex);
    assert.ok(
      commands
        .slice(lastDefinitionIndex + 1, itemLabelIndex)
        .some(
          (args) =>
            args[0] === "api" &&
            args[1]?.endsWith(`/issues/${number}`) &&
            !args.includes("--method"),
        ),
      JSON.stringify(commands.slice(lastDefinitionIndex + 1, itemLabelIndex)),
    );
    const itemLabelIndexes = commands
      .map((args, index) => ({ args, index }))
      .filter(({ args }) => args[0] === "issue" && args[1] === "edit")
      .map(({ index }) => index);
    for (let index = 1; index < itemLabelIndexes.length; index += 1) {
      const previous = itemLabelIndexes[index - 1] ?? -1;
      const current = itemLabelIndexes[index] ?? -1;
      assert.ok(
        commands
          .slice(previous + 1, current)
          .some(
            (args) =>
              args[0] === "api" &&
              args[1]?.endsWith(`/issues/${number}`) &&
              !args.includes("--method"),
          ),
        `expected a fresh item guard between fallback edits: ${JSON.stringify(
          commands.slice(previous + 1, current),
        )}`,
      );
    }
    const commentPatchIndex = commands.findIndex(
      (args) =>
        args[0] === "api" &&
        /\/issues\/comments\/\d+$/.test(args[1] ?? "") &&
        args.includes("PATCH"),
    );
    assert.ok(commentPatchIndex > itemLabelIndexes.at(-1)!);
    assert.ok(
      commands
        .slice(itemLabelIndexes.at(-1)! + 1, commentPatchIndex)
        .some(
          (args) =>
            args[0] === "api" &&
            args[1]?.endsWith(`/issues/${number}`) &&
            !args.includes("--method"),
        ),
      `expected a fresh comment guard after recovered label publication: ${JSON.stringify(
        commands.slice(itemLabelIndexes.at(-1)! + 1, commentPatchIndex),
      )}`,
    );
    const patchedComment = readFileSync(patchedCommentPath, "utf8");
    assert.notEqual(patchedComment, synced.comment);
    assert.doesNotMatch(patchedComment, /- add `P2`/);
    assert.doesNotMatch(readFileSync(join(itemsDir, `${number}.md`), "utf8"), /^labels:.*P2/m);
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number,
        action: "review_comment_synced",
        reason: "updated durable Codex review comment",
        durableReviewSynced: true,
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const scenario of [
  { name: "verified newer", lease: "9200", owner: "new-review-owner", verified: true },
  { name: "equal lease", lease: "9100", owner: "new-review-owner", verified: false },
  { name: "unknown owner", lease: "9200", owner: "unknown", verified: false },
  { name: "unsafe lease", lease: "9007199254740992", owner: "new-review-owner", verified: false },
]) {
  test(`issue apply CAS and publisher preserve ${scenario.name} tuple evidence`, () => {
    const root = mkdtempSync(tmpPrefix);
    try {
      const { itemsDir, closedDir, plansDir, reportPath } = createApplyDirectories(root);
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
        review_lease_owner: scenario.owner,
        review_lease_comment_id: scenario.lease,
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
const path = args[1] === "-i" ? args[2] || "" : args[1] || "";
appendFileSync(logPath, JSON.stringify(args) + "\\n");
if (args[0] === "api" && args[1] === "-i" && new RegExp("/issues/${number}/timeline(?:\\\\?|$)").test(path)) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && new RegExp("/issues/${number}/comments(?:\\\\?|$)").test(path) && !args.includes("--method")) {
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
          extraArgs: [
            "--item-numbers",
            String(number),
            "--comment-sync-min-age-days",
            "0",
            "--event-apply-proof",
            "--exact-event-publication",
          ],
        });
        const workRoot = join(root, "publication");
        const artifacts = join(workRoot, "artifacts/event");
        const output = join(workRoot, "github-output");
        const batch = join(workRoot, "batch.json");
        mkdirSync(artifacts, { recursive: true });
        writeFileSync(join(artifacts, `${number}.md`), oldSynced.report);
        const result = spawnSync(
          process.execPath,
          [resolve("dist/repair/publish-event-result.js")],
          {
            cwd: workRoot,
            encoding: "utf8",
            timeout: 30_000,
            env: {
              ...process.env,
              CLAWSWEEPER_CODE_ROOT: process.cwd(),
              EXACT_REVIEW_WORK_ROOT: workRoot,
              EXACT_EVENT_PUBLICATION: "true",
              REVIEW_ONLY: "true",
              TARGET_REPO: "openclaw/clawsweeper",
              ITEM_NUMBER: String(number),
              EXACT_REVIEW_BATCH_MUTATION_OUTPUT: batch,
              GITHUB_OUTPUT: output,
            },
          },
        );
        assert.equal(result.status, scenario.verified ? 0 : 1, result.stdout + result.stderr);
        const disposition = JSON.parse(readFileSync(batch, "utf8"));
        assert.equal(disposition.kind, scenario.verified ? "superseded" : "permanent_failure");
        assert.equal(disposition.plan, undefined);
        if (scenario.verified) {
          assert.deepEqual(disposition.disposition, { requeueLatestExpected: false });
          assert.match(readFileSync(output, "utf8"), /^completion_kind=superseded$/m);
          assert.match(readFileSync(output, "utf8"), /^reason_code=remote_newer_tuple$/m);
        }
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
          reason: `live durable review tuple is newer than the local report: comment lease=${scenario.lease}, report lease=9100`,
          ...(scenario.verified ? { newerReviewTupleVerified: true } : {}),
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("issue apply rejects a stable live source revision that differs from the report", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const { itemsDir, closedDir, plansDir, reportPath } = createApplyDirectories(root);
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
    const { itemsDir, closedDir, plansDir, reportPath } = createApplyDirectories(root);
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

test("apply-decisions rejects a changed close report even when an expired lease is newest", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const { itemsDir, closedDir, plansDir, reportPath } = createApplyDirectories(root);
    const logPath = join(root, "gh.log");
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
    const { itemsDir, closedDir, plansDir, reportPath } = createApplyDirectories(root);
    const logPath = join(root, "gh.log");
    const itemPath = join(itemsDir, "74478.md");
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
  const commentWasPosted = readFileSync(logPath, "utf8").includes("posted-comment-body");
  console.log(JSON.stringify({
    number: 74478,
    title: "Record PR label churn",
    html_url: "https://github.com/openclaw/clawsweeper/pull/74478",
    created_at: "2026-05-19T19:00:00Z",
    updated_at: commentWasPosted ? "2026-05-19T20:00:02Z" : "2026-05-19T20:00:00Z",
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
    const body = JSON.parse(readFileSync(input, "utf8")).body;
    appendFileSync(logPath, JSON.stringify(["posted-comment-body", body]) + "\\n");
    console.log(JSON.stringify({
      id: 987478,
      html_url: "https://github.com/openclaw/clawsweeper/pull/74478#issuecomment-987478",
      user: { login: "clawsweeper[bot]" },
      body
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
    assert.match(report, /^automation_item_updated_at: 2026-05-19T20:00:02Z$/m);
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
    const { itemsDir, closedDir, plansDir, reportPath } = createApplyDirectories(root);
    const logPath = join(root, "gh.log");
    const itemPath = join(itemsDir, "74481.md");
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
  const body = JSON.parse(readFileSync(input, "utf8")).body;
  appendFileSync(logPath, JSON.stringify(["patched-review-body", body]) + "\\n");
  console.log(JSON.stringify({
    id: 987481,
    html_url: "https://github.com/openclaw/openclaw/pull/74481#issuecomment-987481",
    updated_at: "2026-05-19T20:11:00Z",
    user: { login: "clawsweeper[bot]" },
    body
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
      /- reviewed 2026-05-20T00:00:00\.000Z sha old-head :: blocked before merge\./,
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
    const { itemsDir, closedDir, plansDir, reportPath } = createApplyDirectories(root);
    const logPath = join(root, "gh.log");
    const itemPath = join(itemsDir, "74483.md");
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

for (const scenario of [
  "captured discussion and command",
  "same-second human activity",
  "changed receipt",
  "changed timeline receipt",
  "changed head",
] as const) {
  test(`exact publication reconciles labels only for a current review: ${scenario}`, () => {
    const root = mkdtempSync(tmpPrefix);
    try {
      const { itemsDir, closedDir, plansDir, reportPath } = createApplyDirectories(root);
      const logPath = join(root, "gh.log");
      const itemPath = join(itemsDir, "74482.md");
      const headSha = "bc60b889bc60b889bc60b889bc60b889bc60b889";
      const leaseOwner = "exact-pr-74482";
      const leaseCommentId = 1987482;
      const leaseUpdatedAt = new Date(Date.now() - 60_000).toISOString();
      const commandUpdatedAt =
        scenario === "same-second human activity" ? "2026-07-03T21:44:48Z" : "2026-07-03T21:43:00Z";
      const commandBody =
        scenario === "same-second human activity"
          ? "I relabeled this myself; keep my labels."
          : "@clawsweeper re-review";
      const emptyActivityDigest = createHash("sha256").update("[]").digest("hex");
      const sourceRevision = itemSourceRevisionSha256ForTest(
        {
          title: "Fresh head label restore after re-review",
          labels: ["status: 📣 needs proof", "rating: 🦪 silver shellfish"],
        },
        [
          {
            id: 987483,
            body: "Pushed a new head, please take another look.",
            user: { login: "contributor" },
            updated_at: "2026-07-03T21:43:10Z",
          },
          {
            id: 987484,
            body: commandBody,
            user: { login: "contributor" },
            updated_at: commandUpdatedAt,
          },
        ],
      );
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
        reviewed_at: "2026-07-03T21:44:48.750Z",
        item_source_revision: scenario === "changed receipt" ? "stale-source" : sourceRevision,
        review_timeline_revision:
          scenario === "changed timeline receipt" ? "0".repeat(64) : emptyActivityDigest,
        review_activity_cursor: `v1:0:${emptyActivityDigest}`,
        pull_head_sha: scenario === "changed head" ? "a".repeat(40) : headSha,
        review_lease_owner: leaseOwner,
        review_lease_comment_id: String(leaseCommentId),
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

      const leaseComment = renderReviewStartStatusComment({
        number: 74482,
        kind: "pull_request",
        title: "Fresh head label restore after re-review",
        headSha,
        startedAt: leaseUpdatedAt,
        leaseExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        leaseOwner,
      });
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
    created_at: "2026-07-03T21:43:10Z",
    updated_at: "2026-07-03T21:43:10Z"
  },
  {
    id: 987484,
    html_url: "https://github.com/openclaw/openclaw/pull/74482#issuecomment-987484",
    body: ${JSON.stringify(commandBody)},
    user: { login: "contributor" },
    author_association: "CONTRIBUTOR",
    created_at: ${JSON.stringify(commandUpdatedAt)},
    updated_at: ${JSON.stringify(commandUpdatedAt)}
  },
  {
    id: ${leaseCommentId},
    html_url: "https://github.com/openclaw/openclaw/pull/74482#issuecomment-${leaseCommentId}",
    body: ${JSON.stringify(leaseComment)},
    user: { login: "clawsweeper[bot]" },
    created_at: ${JSON.stringify(leaseUpdatedAt)}, updated_at: ${JSON.stringify(leaseUpdatedAt)}
  },
  ...Array.from({ length: 22 }, (_, index) => ({
    id: 987500 + index,
    html_url: "https://github.com/openclaw/openclaw/pull/74482#issuecomment-" + (987500 + index),
    body: "automation update " + (index + 1),
    user: { login: "clawsweeper[bot]" },
    created_at: "2026-07-03T21:45:00Z",
    updated_at: "2026-07-03T21:45:00Z"
  }))
];
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] || "";
const reReviewTimeline = [];
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
    head: { sha: ${JSON.stringify(headSha)}, ref: "branch", repo: { full_name: "fork/openclaw" } },
    base: { sha: "base-sha", ref: "main", repo: { full_name: "openclaw/openclaw" } },
    user: { login: "contributor" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/74482\\/(files|commits|comments|reviews)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && path.includes("/commits/${headSha}/check-runs")) {
  console.log(JSON.stringify({ total_count: 0, check_runs: [] }));
} else if (args[0] === "api" && path.includes("/commits/${headSha}/status")) {
  console.log(JSON.stringify({ state: "success", statuses: [] }));
} else if (args[0] === "api" && path === "repos/openclaw/openclaw/issues/comments/${leaseCommentId}" && args.includes("DELETE")) {
  console.log("");
} else if (args[0] === "api" && /\\/issues\\/74482\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify(args.includes("--paginate") ? [comments] : comments));
} else if (args[0] === "api" && /\\/issues\\/comments\\/987482$/.test(path)) {
  const input = args[args.indexOf("--input") + 1];
  const body = JSON.parse(readFileSync(input, "utf8")).body;
  appendFileSync(logPath, JSON.stringify(["patched-review-body", body]) + "\\n");
  console.log(JSON.stringify({
    id: 987482,
    html_url: "https://github.com/openclaw/openclaw/pull/74482#issuecomment-987482",
    updated_at: "2026-07-03T21:48:00Z",
    user: { login: "clawsweeper[bot]" },
    body
  }));
} else if (args[0] === "issue" && args[1] === "edit") {
  console.log("");
} else if (args[0] === "label" && args[1] === "list") {
  console.log("[]");
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
          extraArgs: [
            "--sync-comments-only",
            "--exact-event-publication",
            "--skip-dashboard",
            "--item-number",
            "74482",
          ],
        });
      });

      const updatedReport = readFileSync(itemPath, "utf8");
      const calls = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
      const edits = calls.filter((args) => args[0] === "issue" && args[1] === "edit");
      if (scenario !== "captured discussion and command") {
        assert.equal(edits.length, 0);
        assert.doesNotMatch(updatedReport, /^labels_synced_at: /m);
        return;
      }
      assert.equal(edits.length, 1);
      assert.match(updatedReport, /^labels_synced_at: /m);
      const edit = edits[0]!;
      const labels = (flag: string) => (edit[edit.indexOf(flag) + 1] ?? "").split(",");
      assert.deepEqual(labels("--remove-label").sort(), [
        "rating: 🦪 silver shellfish",
        "status: 📣 needs proof",
      ]);
      for (const label of [
        "proof: sufficient",
        "rating: 🦞 diamond lobster",
        "status: 👀 ready for maintainer look",
        "merge-risk: 🚨 session-state",
      ]) {
        assert(labels("--add-label").includes(label));
      }
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
}

test("apply-decisions skips fresh-head PR label sync when humans act after the review snapshot", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const { itemsDir, closedDir, plansDir, reportPath } = createApplyDirectories(root);
    const logPath = join(root, "gh.log");
    const itemPath = join(itemsDir, "74483.md");
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
  const body = JSON.parse(readFileSync(input, "utf8")).body;
  appendFileSync(logPath, JSON.stringify(["patched-review-body", body]) + "\\n");
  console.log(JSON.stringify({
    id: 987484,
    html_url: "https://github.com/openclaw/openclaw/pull/74483#issuecomment-987484",
    updated_at: "2026-07-03T21:48:00Z",
    user: { login: "clawsweeper[bot]" },
    body
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
    const { itemsDir, closedDir, plansDir, reportPath } = createApplyDirectories(root);
    const logPath = join(root, "gh.log");
    const itemPath = join(itemsDir, "74484.md");
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
    const { itemsDir, closedDir, plansDir, reportPath } = createApplyDirectories(root);
    const labelLogPath = join(root, "label-sync.log");
    const itemPath = join(itemsDir, "74480.md");

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

test("apply-decisions clears a recovery escalation only after publishing a completed PR review", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const { itemsDir, closedDir, plansDir, reportPath } = createApplyDirectories(root);
    const logPath = join(root, "gh.log");
    const itemPath = join(itemsDir, "74479.md");
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
        labels: JSON.stringify(["clawsweeper-recovery-stuck"]),
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
    labels: ["clawsweeper-recovery-stuck"],
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
  const body = JSON.parse(readFileSync(input, "utf8")).body;
  appendFileSync(logPath, JSON.stringify(["patched-review-body", body]) + "\\n");
  console.log(JSON.stringify({
    id: 987479,
    html_url: "https://github.com/openclaw/clawsweeper/pull/74479#issuecomment-987479",
    user: { login: "clawsweeper[bot]" },
    body
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
    const publicationIndex = calls.findIndex((args) => args[0] === "patched-review-body");
    const recoveryCleanupIndex = calls.findIndex(
      (args) =>
        args[0] === "issue" &&
        args[1] === "edit" &&
        args.includes("--remove-label") &&
        args.includes("clawsweeper-recovery-stuck"),
    );
    assert.ok(publicationIndex >= 0);
    assert.ok(recoveryCleanupIndex > publicationIndex);
    const updatedReport = readFileSync(itemPath, "utf8");
    assert.match(updatedReport, /^labels_synced_at: /m);
    assert.doesNotMatch(updatedReport, /clawsweeper-recovery-stuck/);
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
      {
        number: 74479,
        action: "review_comment_synced",
        reason: "updated durable Codex review comment; cleared resolved review recovery label",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply preserves an in-flight exact-head review lease and defers old report actions", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const { itemsDir, closedDir, plansDir, reportPath } = createApplyDirectories(root);
    const number = 74486;
    const headSha = "0123456789abcdef0123456789abcdef01234567";
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();

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
    const { itemsDir, closedDir, plansDir, reportPath } = createApplyDirectories(root);
    const number = 74489;
    const headSha = "0123456789abcdef0123456789abcdef01234567";
    const startedAt = new Date(Date.now() - 30_000).toISOString();
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();

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

test("durable publication never deletes a legacy lease that can refresh concurrently", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const { itemsDir, closedDir, plansDir, reportPath } = createApplyDirectories(root);
    const commentWriteLogPath = join(root, "comment-writes.log");
    const number = 74493;
    const headSha = "0123456789abcdef0123456789abcdef01234567";
    const startedAt = new Date(Date.now() - 2 * 60_000).toISOString();
    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    const refreshedAt = new Date(Date.now() + 30 * 60_000).toISOString();

    const closeReport = lowSignalCloseReport({
      number,
      title: "Do not delete a concurrently refreshed legacy lease",
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
    const legacyLeaseComment = (expiresAt: string) =>
      [
        "Codex review: legacy duplicate.",
        "",
        `<!-- clawsweeper-review-status:started item=${number} sha=${headSha} started_at=${startedAt} lease_expires_at=${expiresAt} owner=legacy-worker v=1 -->`,
        "",
        `<!-- clawsweeper-review item=${number} -->`,
      ].join("\n");
    const commentRecord = (id: number, body: string, updatedAt: string) => ({
      id,
      html_url: `https://github.com/openclaw/openclaw/pull/${number}#issuecomment-${id}`,
      created_at: startedAt,
      updated_at: updatedAt,
      user: { login: "clawsweeper[bot]" },
      body,
    });
    const canonicalId = 9000 + number;
    const duplicateId = 8000 + number;
    const canonical = commentRecord(canonicalId, staleDurableComment, new Date().toISOString());
    const expiredDuplicate = commentRecord(duplicateId, legacyLeaseComment(expiredAt), startedAt);
    const refreshedDuplicate = commentRecord(
      duplicateId,
      legacyLeaseComment(refreshedAt),
      new Date().toISOString(),
    );

    withMockGh(
      root,
      promotionGhMock({
        number,
        title: "Do not delete a concurrently refreshed legacy lease",
        headSha,
        comment: staleDurableComment,
        comments: [canonical, expiredDuplicate],
        commentsAfterCommentWrite: [canonical, refreshedDuplicate],
        commentWriteLogPath,
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
    const writes = readFileSync(commentWriteLogPath, "utf8");
    assert.match(writes, new RegExp(`/issues/comments/${canonicalId}.*--method PATCH`));
    assert.doesNotMatch(writes, new RegExp(`/issues/comments/${duplicateId}.*--method DELETE`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply defers incomplete old report actions when a same-head review finishes mid-run", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const { itemsDir, closedDir, plansDir, reportPath } = createApplyDirectories(root);
    const number = 74488;
    const headSha = "0123456789abcdef0123456789abcdef01234567";
    const oldReviewedAt = "2026-05-01T00:00:00Z";
    const newReviewedAt = new Date().toISOString();

    const closeReport = lowSignalCloseReport({
      number,
      title: "Do not apply an old verdict after re-review finishes",
      pull_head_sha: headSha,
      reviewed_at: oldReviewedAt,
      review_lease_owner: "older-review",
      review_lease_comment_id: "1000",
    });
    const synced = reportWithSyncedReviewComment(closeReport, number, "low_signal_unmergeable_pr");
    const newerComment = synced.comment
      .replaceAll(
        `reviewed_at=${new Date(oldReviewedAt).toISOString()}`,
        `reviewed_at=${newReviewedAt}`,
      )
      .replaceAll("lease_owner=older-review", "lease_owner=newer-review")
      .replaceAll("lease_comment_id=1000", "lease_comment_id=1001");
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
    const { itemsDir, closedDir, plansDir, reportPath } = createApplyDirectories(root);
    const logPath = join(root, "gh.log");
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
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/456\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && args[1] === "graphql") {
  console.log(JSON.stringify({ data: { repository: { issue: { state: "CLOSED", timelineItems: { nodes: [{ __typename: "ClosedEvent", createdAt: "2026-05-01T02:00:00Z", closer: { __typename: "PullRequest", number: 900, repository: { nameWithOwner: "openclaw/clawsweeper" } } }] } } } } }));
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

test("apply-decisions verifies provenance after a closeout note and before closing PR proposals", () => {
  for (const scenario of [
    "normal",
    "multiple_linked_issues",
    "mismatched_canonical",
    "mismatched_canonical_repository",
    "missing_canonical_merge",
    "paired_keep_open",
    "paired_review_stale",
    "paired_source_change_during_closeout",
    "paired_metadata_change_during_closeout",
    "paired_bot_activity_during_closeout",
    "paired_self_timestamp_settles_late",
    "paired_fresh_owned_review_comment",
    "paired_durable_review_mismatch",
    "paired_locked_closeout_cleanup",
    "paired_provenance_revoked_before_close",
    "paired_provenance_retargeted_before_close",
    "paired_human_activity_during_lease",
  ] as const) {
    const multipleLinkedIssues = scenario === "multiple_linked_issues";
    const mismatchedCanonical = scenario === "mismatched_canonical";
    const mismatchedCanonicalRepository = scenario === "mismatched_canonical_repository";
    const missingCanonicalMerge = scenario === "missing_canonical_merge";
    const pairedKeepOpen = scenario === "paired_keep_open";
    const pairedReviewStale = scenario === "paired_review_stale";
    const pairedSourceChangeDuringCloseout = scenario === "paired_source_change_during_closeout";
    const pairedMetadataChangeDuringCloseout =
      scenario === "paired_metadata_change_during_closeout";
    const pairedBotActivityDuringCloseout = scenario === "paired_bot_activity_during_closeout";
    const pairedSelfTimestampSettlesLate = scenario === "paired_self_timestamp_settles_late";
    const pairedFreshOwnedReviewComment = scenario === "paired_fresh_owned_review_comment";
    const pairedDurableReviewMismatch = scenario === "paired_durable_review_mismatch";
    const pairedLockedCloseoutCleanup = scenario === "paired_locked_closeout_cleanup";
    const pairedProvenanceRevokedBeforeClose =
      scenario === "paired_provenance_revoked_before_close";
    const pairedProvenanceRetargetedBeforeClose =
      scenario === "paired_provenance_retargeted_before_close";
    const pairedHumanActivityDuringLease = scenario === "paired_human_activity_during_lease";
    const root = mkdtempSync(tmpPrefix);
    try {
      const { itemsDir, closedDir, plansDir, reportPath } = createApplyDirectories(root);
      const logPath = join(root, "gh.log");
      const postedBodiesPath = join(root, "posted-bodies.jsonl");
      const prCommentPath = join(root, "pr-review-comment");
      const linkedIssueCommentPath = join(root, "linked-issue-review-comment");
      const reviewedSourceRevision = itemSourceRevisionSha256ForTest(
        {
          title: "Render work plans",
          labels: ["maintainer"],
        },
        [[]],
      );
      const closeReport = `${workPlanCandidateReport({
        type: "pull_request",
        decision: "close",
        action_taken: "proposed_close",
        close_reason: "implemented_on_main",
        confidence: "high",
        item_snapshot_hash: "reviewed-snapshot",
        item_updated_at: "2026-05-01T00:00:00Z",
        item_source_revision: reviewedSourceRevision,
        pull_head_sha: "head-sha",
        reproduction_status: "reproduced",
        reproduction_confidence: "high",
        fixed_pr_url: mismatchedCanonicalRepository
          ? "https://github.com/openclaw/other-repository/pull/900"
          : `https://github.com/openclaw/clawsweeper/pull/${mismatchedCanonical ? "901" : "900"}`,
        fixed_pr_number: mismatchedCanonical ? "901" : "900",
        fixed_pr_confidence: "high",
        fixed_pr_source: "GitHub verified implementation landing",
        fixed_pr_merged_at: "2026-05-01T02:00:00Z",
        fixed_sha: "1234567890abcdef1234567890abcdef12345678",
        fixed_at: "2026-05-01T02:00:00Z",
      })}\n\n## Evidence\n\n- **main fix:** git show confirms current main has the replacement implementation and it is not in the latest release yet\n  - file: [src/clawsweeper.ts](https://github.com/openclaw/clawsweeper/blob/1234567890abcdef1234567890abcdef12345678/src/clawsweeper.ts)\n  - sha: [1234567890ab](https://github.com/openclaw/clawsweeper/commit/1234567890abcdef1234567890abcdef12345678)\n\n## Close Comment\n\nClosing this PR because the fix is already on main.\n`;
      const synced = reportWithSyncedReviewComment(closeReport, 321, "implemented_on_main");
      const linkedIssueReport = implementedCloseReport({
        repository: "openclaw/clawsweeper",
        number: 456,
        type: "issue",
        item_updated_at: pairedReviewStale ? "2026-05-01T00:00:00Z" : "2026-05-02T00:00:00Z",
        fixed_pr_url: "https://github.com/openclaw/clawsweeper/pull/900",
        fixed_pr_number: "900",
        fixed_pr_confidence: "high",
        fixed_pr_source: "GitHub verified implementation landing",
        fixed_pr_merged_at: missingCanonicalMerge ? "unknown" : "2026-05-01T02:00:00Z",
      }).replaceAll("openclaw/openclaw", "openclaw/clawsweeper");
      const linkedIssueSynced = reportWithSyncedReviewComment(
        pairedKeepOpen
          ? linkedIssueReport.replace(/^decision: close$/m, "decision: keep_open")
          : linkedIssueReport,
        456,
        "implemented_on_main",
      );
      writeFileSync(join(itemsDir, "321.md"), synced.report, "utf8");
      if (!multipleLinkedIssues) {
        writeFileSync(join(itemsDir, "456.md"), linkedIssueSynced.report, "utf8");
        writeFileSync(
          linkedIssueCommentPath,
          pairedDurableReviewMismatch
            ? `${linkedIssueSynced.comment}\n\nNewer contradictory bot verdict.`
            : linkedIssueSynced.comment,
          "utf8",
        );
      }
      writeFileSync(prCommentPath, synced.comment, "utf8");

      const ghMock = `
const { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const postedBodiesPath = ${JSON.stringify(postedBodiesPath)};
const closeoutPostedPath = ${JSON.stringify(join(root, "closeout-posted"))};
const pairedIssueCloseoutPostedPath = ${JSON.stringify(join(root, "paired-issue-closeout-posted"))};
const pairedIssueBotActivityPath = ${JSON.stringify(join(root, "paired-issue-bot-activity"))};
const pairedIssueHumanActivityPath = ${JSON.stringify(join(root, "paired-issue-human-activity"))};
const pairedIssueReadsAfterCloseoutPath = ${JSON.stringify(join(root, "paired-issue-reads-after-closeout"))};
const pairedIssueLeasePath = ${JSON.stringify(join(root, "paired-issue-lease"))};
const pairedIssueLeaseWritesPath = ${JSON.stringify(join(root, "paired-issue-lease-writes"))};
const prCommentPath = ${JSON.stringify(prCommentPath)};
const linkedIssueCommentPath = ${JSON.stringify(linkedIssueCommentPath)};
const linkedIssueComment = ${JSON.stringify(linkedIssueSynced.comment)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args[1] || "";
const multipleLinkedIssues = ${multipleLinkedIssues};
const pairedSourceChangeDuringCloseout = ${pairedSourceChangeDuringCloseout};
const pairedMetadataChangeDuringCloseout = ${pairedMetadataChangeDuringCloseout};
const pairedBotActivityDuringCloseout = ${pairedBotActivityDuringCloseout};
const pairedSelfTimestampSettlesLate = ${pairedSelfTimestampSettlesLate};
const pairedFreshOwnedReviewComment = ${pairedFreshOwnedReviewComment};
// Re-reading a comment must not invent a newer server timestamp.
const freshOwnedReviewUpdatedAt = ${JSON.stringify(new Date().toISOString())};
const pairedDurableReviewMismatch = ${pairedDurableReviewMismatch};
const pairedLockedCloseoutCleanup = ${pairedLockedCloseoutCleanup};
const pairedProvenanceRevokedBeforeClose = ${pairedProvenanceRevokedBeforeClose};
const pairedProvenanceRetargetedBeforeClose = ${pairedProvenanceRetargetedBeforeClose};
const pairedHumanActivityDuringLease = ${pairedHumanActivityDuringLease};
if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/456\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "api" && args[1] === "graphql") {
  const closingReferenceQuery = args.some((argument) => argument.includes("closingIssuesReferences"));
  const closingReferenceNodes = closingReferenceQuery
    ? pairedProvenanceRevokedBeforeClose && existsSync(pairedIssueLeasePath)
      ? []
      : [{
          number:
            pairedProvenanceRetargetedBeforeClose &&
            existsSync(pairedIssueLeaseWritesPath) &&
            Number(readFileSync(pairedIssueLeaseWritesPath, "utf8")) >= 2 &&
            existsSync(pairedIssueLeasePath)
              ? 457
              : 456,
          state: "OPEN",
          repository: { nameWithOwner: "openclaw/clawsweeper" }
        }]
    : [];
  const timelineNodes = [{ __typename: "ClosedEvent", createdAt: "2026-05-01T02:00:00Z", closer: { __typename: "PullRequest", number: 900, url: "https://github.com/openclaw/clawsweeper/pull/900", mergedAt: "2026-05-01T02:00:00Z", repository: { nameWithOwner: "openclaw/clawsweeper" } } }];
  const repository = closingReferenceQuery
    ? { pullRequest: { closingIssuesReferences: { nodes: closingReferenceNodes } } }
    : { issue: { state: "CLOSED", timelineItems: { nodes: timelineNodes } } };
  console.log(JSON.stringify({ data: { repository } }));
} else if (args[0] === "api" && /\\/commits\\/head-sha\\/(?:check-runs|status)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify({ check_runs: [] }));
} else if (args[0] === "api" && /^search\\/issues\\?/.test(path)) {
  console.log(JSON.stringify({ items: [] }));
} else if (args[0] === "api" && /\\/issues\\/456\\/comments(?:\\?|$)/.test(path)) {
  if (args.includes("--method") && args.includes("POST")) {
    const input = args[args.indexOf("--input") + 1];
    const payload = JSON.parse(readFileSync(input, "utf8"));
    if (payload.body.includes("clawsweeper-review-lease item=456")) {
      const leaseWrites = existsSync(pairedIssueLeaseWritesPath)
        ? Number(readFileSync(pairedIssueLeaseWritesPath, "utf8"))
        : 0;
      writeFileSync(pairedIssueLeaseWritesPath, String(leaseWrites + 1), "utf8");
      if (
        pairedHumanActivityDuringLease &&
        existsSync(pairedIssueCloseoutPostedPath) &&
        !existsSync(pairedIssueHumanActivityPath)
      ) {
        writeFileSync(pairedIssueHumanActivityPath, new Date(Date.now() + 60_000).toISOString());
      }
      writeFileSync(pairedIssueLeasePath, payload.body, "utf8");
      console.log(JSON.stringify({ id: 9460, html_url: "https://github.com/openclaw/clawsweeper/issues/456#issuecomment-9460" }));
      process.exit(0);
    }
    if (pairedLockedCloseoutCleanup) {
      console.error("gh: conversation is locked (HTTP 403)");
      process.exit(1);
    }
    appendFileSync(postedBodiesPath, JSON.stringify(payload.body) + "\\n");
    writeFileSync(linkedIssueCommentPath, payload.body, "utf8");
    if (
      pairedSourceChangeDuringCloseout ||
      pairedMetadataChangeDuringCloseout ||
      pairedBotActivityDuringCloseout ||
      pairedProvenanceRetargetedBeforeClose ||
      pairedHumanActivityDuringLease ||
      (pairedSelfTimestampSettlesLate && payload.body.includes("clawsweeper-close-applied"))
    ) writeFileSync(pairedIssueCloseoutPostedPath, "true");
    if (pairedBotActivityDuringCloseout) writeFileSync(pairedIssueBotActivityPath, new Date(Date.now() + 60_000).toISOString());
    console.log(JSON.stringify({ id: 9456, html_url: "https://github.com/openclaw/clawsweeper/issues/456#issuecomment-9456" }));
  } else {
    const comments = [{
      id: 9456,
      html_url: "https://github.com/openclaw/clawsweeper/issues/456#issuecomment-9456",
      created_at: "2026-05-01T01:00:00Z",
      updated_at: pairedFreshOwnedReviewComment ? freshOwnedReviewUpdatedAt : "2026-05-01T01:00:00Z",
      user: { login: "clawsweeper[bot]" },
      body: readFileSync(linkedIssueCommentPath, "utf8")
    }];
    if (pairedFreshOwnedReviewComment) {
      comments.push({
        id: 9455,
        html_url: "https://github.com/openclaw/clawsweeper/issues/456#issuecomment-9455",
        created_at: "2026-05-01T00:59:00Z",
        updated_at: freshOwnedReviewUpdatedAt,
        user: { login: "clawsweeper[bot]" },
        body: linkedIssueComment
      });
    }
    if (existsSync(pairedIssueBotActivityPath)) {
      comments.push({
        id: 9457,
        html_url: "https://github.com/openclaw/clawsweeper/issues/456#issuecomment-9457",
        created_at: readFileSync(pairedIssueBotActivityPath, "utf8"),
        updated_at: readFileSync(pairedIssueBotActivityPath, "utf8"),
        user: { login: "third-party[bot]", type: "Bot" },
        body: "Automated follow-up."
      });
    }
    if (existsSync(pairedIssueHumanActivityPath)) {
      comments.push({
        id: 9458,
        html_url: "https://github.com/openclaw/clawsweeper/issues/456#issuecomment-9458",
        created_at: readFileSync(pairedIssueHumanActivityPath, "utf8"),
        updated_at: readFileSync(pairedIssueHumanActivityPath, "utf8"),
        user: { login: "contributor", type: "User" },
        body: "Please keep this issue open."
      });
    }
    if (existsSync(pairedIssueLeasePath)) {
      comments.push({
        id: 9460,
        html_url: "https://github.com/openclaw/clawsweeper/issues/456#issuecomment-9460",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        user: { login: "clawsweeper[bot]" },
        body: readFileSync(pairedIssueLeasePath, "utf8")
      });
    }
    console.log(JSON.stringify([comments]));
  }
} else if (args[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(path)) {
  if (args.includes("--method") && args.includes("POST")) {
    const input = args[args.indexOf("--input") + 1];
    const payload = JSON.parse(readFileSync(input, "utf8"));
    appendFileSync(postedBodiesPath, JSON.stringify(payload.body) + "\\n");
    writeFileSync(prCommentPath, payload.body, "utf8");
    writeFileSync(closeoutPostedPath, "true");
    console.log(JSON.stringify({ id: 9322, html_url: "https://github.com/openclaw/clawsweeper/pull/321#issuecomment-9322" }));
  } else {
    const comments = [{
      id: 9321,
      html_url: "https://github.com/openclaw/clawsweeper/pull/321#issuecomment-9321",
      created_at: "2026-05-01T01:00:00Z",
      updated_at: "2026-05-01T01:00:00Z",
      user: { login: "clawsweeper[bot]" },
      body: readFileSync(prCommentPath, "utf8")
    }];
    console.log(JSON.stringify([comments]));
  }
} else if (args[0] === "api" && /\\/issues\\/comments\\/9456$/.test(path) && args.includes("PATCH")) {
  const input = args[args.indexOf("--input") + 1];
  const payload = JSON.parse(readFileSync(input, "utf8"));
  appendFileSync(postedBodiesPath, JSON.stringify(payload.body) + "\\n");
  writeFileSync(
    linkedIssueCommentPath,
    pairedDurableReviewMismatch ? payload.body + "\\n\\nNewer contradictory bot verdict." : payload.body,
    "utf8"
  );
  console.log(JSON.stringify({ id: 9456, html_url: "https://github.com/openclaw/clawsweeper/issues/456#issuecomment-9456" }));
} else if (args[0] === "api" && /\\/issues\\/comments\\/9460$/.test(path) && args.includes("DELETE")) {
  if (pairedLockedCloseoutCleanup) {
    console.error("gh: conversation is locked (HTTP 403)");
    process.exit(1);
  }
  if (existsSync(pairedIssueLeasePath)) unlinkSync(pairedIssueLeasePath);
  console.log("");
} else if (args[0] === "api" && /\\/issues\\/comments\\/9321$/.test(path)) {
  const input = args[args.indexOf("--input") + 1];
  const payload = JSON.parse(readFileSync(input, "utf8"));
  appendFileSync(postedBodiesPath, JSON.stringify(payload.body) + "\\n");
  writeFileSync(prCommentPath, payload.body, "utf8");
  console.log(JSON.stringify({
    id: 9321,
    html_url: "https://github.com/openclaw/clawsweeper/pull/321#issuecomment-9321",
    user: { login: "clawsweeper[bot]" },
    body: payload.body
  }));
} else if (args[0] === "api" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Render work plans",
    html_url: "https://github.com/openclaw/clawsweeper/pull/321",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: existsSync(closeoutPostedPath)
      ? "2026-05-01T02:30:00Z"
      : "2026-05-01T00:00:00Z",
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
} else if (args[0] === "api" && /\\/issues\\/456$/.test(path)) {
  const pairedIssueReadsAfterCloseout = existsSync(pairedIssueCloseoutPostedPath)
    ? (existsSync(pairedIssueReadsAfterCloseoutPath)
        ? Number(readFileSync(pairedIssueReadsAfterCloseoutPath, "utf8") || "0")
        : 0) + 1
    : 0;
  if (existsSync(pairedIssueCloseoutPostedPath)) {
    writeFileSync(pairedIssueReadsAfterCloseoutPath, String(pairedIssueReadsAfterCloseout));
  }
  console.log(JSON.stringify({
    number: 456,
    title: pairedSourceChangeDuringCloseout && existsSync(pairedIssueCloseoutPostedPath)
      ? "Render work plans with contributor changes"
      : "Render work plans",
    html_url: "https://github.com/openclaw/clawsweeper/issues/456",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: pairedSelfTimestampSettlesLate && pairedIssueReadsAfterCloseout >= 4
      ? "2026-05-02T00:00:01Z"
      : "2026-05-02T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "issue-reporter" },
    labels: [],
    milestone: pairedMetadataChangeDuringCloseout && existsSync(pairedIssueCloseoutPostedPath)
      ? { number: 1, title: "maintainer follow-up" }
      : null,
    body: "The tracked implementation gap.",
    comments: 0,
    pull_request: null
  }));
} else if (args[0] === "api" && path === "repos/openclaw/clawsweeper") {
  console.log(JSON.stringify({ default_branch: "main" }));
} else if (args[0] === "api" && /\\/compare\\/fixed-sha\\.\\.\\.main$/.test(path)) {
  console.log(JSON.stringify({ status: "ahead" }));
} else if (args[0] === "api" && /\\/pulls\\/900$/.test(path)) {
  console.log(JSON.stringify({
    number: 900,
    title: "fix: rendered work plans",
    html_url: "https://github.com/openclaw/clawsweeper/pull/900",
    state: "closed",
    merged: true,
    merged_at: "2026-05-01T02:00:00Z",
    merge_commit_sha: "fixed-sha",
    head: { sha: "fixed-head" },
    base: { ref: "main" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    html_url: "https://github.com/openclaw/clawsweeper/pull/321",
    state: "open",
    changed_files: 0,
    commits: 0,
    review_comments: 0,
    body: multipleLinkedIssues
      ? "Fixes #456\\nCloses #457"
      : pairedProvenanceRetargetedBeforeClose &&
          existsSync(pairedIssueLeaseWritesPath) &&
          Number(readFileSync(pairedIssueLeaseWritesPath, "utf8")) >= 2 &&
          existsSync(pairedIssueLeasePath)
        ? "Fixes #457"
        : "Fixes #456",
    head: { sha: "head-sha", ref: "branch", repo: { full_name: "fork/clawsweeper" } },
    base: { sha: "base-sha", ref: "main", repo: { full_name: "openclaw/clawsweeper" } },
    user: { login: "reporter" }
  }));
} else if (args[0] === "api" && /\\/pulls\\/321\\/reviews(?:\\?|$)/.test(path)) {
  console.log("[]");
} else if (args[0] === "api" && /\\/pulls\\/321\\/(files|commits|comments|reviews)(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "pr" && args[1] === "close" && args[2] === "321") {
  console.log("");
} else if (args[0] === "api" && path === "repos/openclaw/clawsweeper/issues/456" && args.includes("PATCH")) {
  console.log("");
} else if (args[0] === "issue" && args[1] === "close" && args[2] === "456") {
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
          extraArgs: ["--apply-kind", "all", "--processed-limit", "3"],
        });
        if (
          scenario === "normal" ||
          pairedSelfTimestampSettlesLate ||
          pairedFreshOwnedReviewComment ||
          pairedLockedCloseoutCleanup ||
          pairedProvenanceRevokedBeforeClose ||
          pairedProvenanceRetargetedBeforeClose ||
          pairedHumanActivityDuringLease
        ) {
          runApplyDecisionsForTest({
            itemsDir,
            closedDir,
            plansDir,
            reportPath,
            extraArgs: ["--apply-kind", "all", "--processed-limit", "3"],
          });
        }
      });
      const calls = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
      const closeIndex = calls.findIndex(
        (args) => args[0] === "pr" && args[1] === "close" && args[2] === "321",
      );
      const pairedIssueCloseIndex = calls.findIndex(
        (args) =>
          args[0] === "api" &&
          args[1] === "repos/openclaw/clawsweeper/issues/456" &&
          args.includes("PATCH"),
      );
      const pairedIssueLeaseDeleteIndex = calls.findIndex(
        (args) =>
          args[0] === "api" &&
          (args[1] ?? "").endsWith("/issues/comments/9460") &&
          args.includes("DELETE"),
      );
      const graphqlIndices = calls
        .map((args, index) => (args[0] === "api" && args[1] === "graphql" ? index : -1))
        .filter((index) => index >= 0);
      if (pairedLockedCloseoutCleanup) {
        assert.ok(pairedIssueLeaseDeleteIndex >= 0);
        assert.equal(pairedIssueCloseIndex, -1);
        assert.equal(closeIndex, -1);
        assert.equal(existsSync(join(closedDir, "456.md")), false);
        assert.equal(existsSync(join(closedDir, "321.md")), false);
        const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
          action: string;
          reason: string;
        }>;
        assert.equal(
          report.some(
            (entry) =>
              entry.action === "skipped_locked_conversation" &&
              entry.reason ===
                "linked issue conversation was locked while recording closeout evidence",
          ),
          true,
          JSON.stringify(report),
        );
        continue;
      }
      if (pairedDurableReviewMismatch) {
        const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
          action: string;
          reason: string;
        }>;
        assert.equal(pairedIssueCloseIndex, -1, JSON.stringify(report));
        assert.equal(closeIndex, -1);
        assert.equal(existsSync(join(closedDir, "456.md")), false);
        assert.equal(existsSync(join(closedDir, "321.md")), false);
        assert.equal(
          report.some(
            (entry) =>
              entry.action === "kept_open" &&
              entry.reason ===
                "implemented-on-main paired closeout requires an exact current durable review comment for the linked issue report",
          ),
          true,
          JSON.stringify(report),
        );
        continue;
      }
      if (multipleLinkedIssues) {
        assert.equal(closeIndex, -1);
        assert.equal(existsSync(join(closedDir, "321.md")), false);
        const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
          action: string;
          reason: string;
        }>;
        assert.equal(
          report.some(
            (entry) =>
              entry.action === "kept_open" && entry.reason.includes("exactly one explicit"),
          ),
          true,
        );
        continue;
      }
      if (
        mismatchedCanonical ||
        mismatchedCanonicalRepository ||
        missingCanonicalMerge ||
        pairedKeepOpen ||
        pairedReviewStale ||
        pairedSourceChangeDuringCloseout ||
        pairedMetadataChangeDuringCloseout ||
        pairedBotActivityDuringCloseout
      ) {
        assert.equal(closeIndex, -1);
        assert.equal(existsSync(join(closedDir, "321.md")), false);
        const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
          action: string;
          reason: string;
        }>;
        assert.equal(
          report.some((entry) => entry.action === "kept_open"),
          true,
        );
        continue;
      }
      if (pairedProvenanceRevokedBeforeClose) {
        assert.ok(graphqlIndices.length >= 2);
        assert.equal(pairedIssueCloseIndex, -1);
        assert.equal(closeIndex, -1);
        assert.equal(existsSync(join(closedDir, "456.md")), false);
        assert.equal(existsSync(join(closedDir, "321.md")), false);
        const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
          action: string;
          reason: string;
        }>;
        assert.equal(
          report.some(
            (entry) =>
              entry.action === "kept_open" &&
              entry.reason ===
                "implemented-on-main close no longer has current GitHub issue-to-fixing-pull-request provenance",
          ),
          true,
          JSON.stringify(report),
        );
        continue;
      }
      if (pairedProvenanceRetargetedBeforeClose) {
        assert.equal(pairedIssueCloseIndex, -1);
        assert.equal(closeIndex, -1);
        assert.equal(existsSync(join(closedDir, "456.md")), false);
        assert.equal(existsSync(join(closedDir, "321.md")), false);
        const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
          action: string;
          reason: string;
        }>;
        assert.equal(
          report.some(
            (entry) =>
              entry.action === "kept_open" &&
              entry.reason ===
                "implemented-on-main close current issue link no longer matches the leased paired issue",
          ),
          true,
          JSON.stringify(report),
        );
        continue;
      }
      if (pairedHumanActivityDuringLease) {
        assert.equal(pairedIssueCloseIndex, -1);
        assert.equal(closeIndex, -1);
        assert.equal(existsSync(join(closedDir, "456.md")), false);
        assert.equal(existsSync(join(closedDir, "321.md")), false);
        const report = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
          action: string;
          reason: string;
        }>;
        assert.equal(
          report.some(
            (entry) =>
              entry.action === "kept_open" &&
              entry.reason ===
                "implemented-on-main paired closeout requires linked issue #456 to remain unchanged, unlocked, and free of new activity after acquiring its mutation lease",
          ),
          true,
          JSON.stringify(report),
        );
        continue;
      }
      assert.ok(graphqlIndices.length >= 2);
      assert.ok(closeIndex >= 0, `${scenario}: ${readFileSync(reportPath, "utf8")}`);
      assert.ok(pairedIssueCloseIndex >= 0, scenario);
      assert.ok(pairedIssueCloseIndex < closeIndex);
      const postedBodies = readFileSync(postedBodiesPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string);
      const closeAppliedBodies = postedBodies.filter((body) =>
        body.includes("clawsweeper-close-applied"),
      );
      assert.equal(closeAppliedBodies.length, 2);
      assert.match(
        closeAppliedBodies[0],
        /ClawSweeper recorded implementation evidence for this proposed close/,
      );
      assert.match(closeAppliedBodies[0], /Close reason: already implemented on main/);
      assert.match(closeAppliedBodies[0], /Implementation evidence: \[fix PR #900\]/);
      assert.match(closeAppliedBodies[0], /clawsweeper-close-applied item=321/);
      assert.match(closeAppliedBodies[1], /Implementation evidence: \[fix PR #900\]/);
      assert.match(closeAppliedBodies[1], /clawsweeper-close-applied item=456/);
      assert.ok(existsSync(join(closedDir, "321.md")));
      assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), [
        {
          number: 456,
          action: "closed",
          reason: "already implemented on main; posted close-applied comment",
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
  }
});

test("apply-decisions keeps low-signal PRs open when live maintainer comments exist", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const { itemsDir, closedDir, plansDir, reportPath } = createApplyDirectories(root);
    const logPath = join(root, "gh.log");
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
