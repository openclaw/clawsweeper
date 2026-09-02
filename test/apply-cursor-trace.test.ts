import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createApplyRecordOperations } from "../dist/clawsweeper-apply-records.js";
import { repositoryProfileFor } from "../dist/repository-profiles.js";

import {
  implementedCloseReport,
  reportWithSyncedReviewComment,
  runApplyDecisionsForTest,
  tmpPrefix,
  withMockGh,
  workPlanCandidateReport,
} from "./helpers.ts";

test("apply resolves only requested paired dependencies and preserves selected snapshots", () => {
  const selected = {
    number: 20,
    name: "20.md",
    path: "items/20.md",
    repo: "openclaw/openclaw",
    markdown: "selected snapshot",
  };
  const paired = {
    ...selected,
    number: 21,
    name: "21.md",
    path: "items/21.md",
    markdown: "independent paired review",
  };
  const reads: number[][] = [];
  const records = createApplyRecordOperations({
    applyKind: "all",
    applyQueueSortFields: () => ({ priority: 0, applyCheckedAt: 0 }),
    canonicalBaselineDir: "",
    closedDir: "closed",
    decisionPacketsDir: "packets",
    dryRun: true,
    itemsDir: "items",
    numberForMarkdownFile: (name) => Number(name.replace(".md", "")),
    plansDir: "plans",
    profile: repositoryProfileFor("openclaw/openclaw"),
    recordRoot: ".",
    requestedItemNumberSet: new Set([20]),
    syncCommentsOnly: false,
    targetRepo: () => "openclaw/openclaw",
    reportEntriesForDir: (_dir, numbers) => {
      assert.ok(numbers, "paired lookup must always be bounded");
      reads.push([...numbers]);
      return numbers.has(21)
        ? [paired]
        : numbers.has(22)
          ? [{ ...paired, number: 22, repo: "other/repo" }]
          : [];
    },
  });
  const lookup = records.createOpenReportLookup([selected], false);
  assert.equal(lookup(20), selected);
  assert.equal(lookup(21), paired);
  assert.equal(lookup(21), paired);
  assert.equal(lookup(22), undefined);
  assert.equal(lookup(23), undefined);
  assert.equal(lookup(23), undefined);
  assert.deepEqual(reads, [[21], [22], [23]]);
  const exactLookup = records.createOpenReportLookup([selected], true);
  assert.equal(exactLookup(21), undefined);
  assert.deepEqual(reads, [[21], [22], [23]]);
});

test("apply-decisions preserves auto-selected order and traces only examined records", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const tracePath = join(root, "apply-cursor-trace.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    for (const number of [10, 20]) {
      writeFileSync(
        join(itemsDir, `${number}.md`),
        workPlanCandidateReport({
          repository: "openclaw/openclaw",
          number,
          local_checkout_access: "unverified",
          decision: "keep_open",
          action_taken: "kept_open",
        }),
        "utf8",
      );
    }

    runApplyDecisionsForTest({
      itemsDir,
      closedDir,
      plansDir,
      reportPath,
      extraArgs: [
        "--target-repo",
        "openclaw/openclaw",
        "--item-numbers",
        "20,10",
        "--processed-limit",
        "1",
        "--cursor-trace",
        tracePath,
      ],
    });

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const trace = JSON.parse(readFileSync(tracePath, "utf8"));
    assert.equal(report[0]?.number, 20);
    assert.deepEqual(trace, { schema_version: 1, examined_item_numbers: [20] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions runs the numeric comment-sync frontier before ascending urgent items", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const tracePath = join(root, "apply-cursor-trace.json");
    const wrappedReportPath = join(root, "wrapped-apply-report.json");
    const wrappedTracePath = join(root, "wrapped-apply-cursor-trace.json");
    const unsortedReportPath = join(root, "unsorted-apply-report.json");
    const unsortedTracePath = join(root, "unsorted-apply-cursor-trace.json");
    const ascending = [87267, 95788, 97566, 105342, 105870];
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    for (const number of ascending) {
      writeFileSync(
        join(itemsDir, `${number}.md`),
        workPlanCandidateReport({
          repository: "openclaw/openclaw",
          number,
          local_checkout_access: "unverified",
          decision: "keep_open",
          action_taken: "kept_open",
        }),
        "utf8",
      );
    }

    runApplyDecisionsForTest({
      itemsDir,
      closedDir,
      plansDir,
      reportPath,
      extraArgs: [
        "--target-repo",
        "openclaw/openclaw",
        "--item-numbers",
        ascending.join(","),
        "--processed-limit",
        "1",
        "--cursor-trace",
        tracePath,
        "--comment-sync-cursor",
        "105854",
      ],
    });

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const trace = JSON.parse(readFileSync(tracePath, "utf8"));
    assert.equal(report[0]?.number, 105870);
    assert.deepEqual(trace, { schema_version: 1, examined_item_numbers: [105870] });

    runApplyDecisionsForTest({
      itemsDir,
      closedDir,
      plansDir,
      reportPath: wrappedReportPath,
      extraArgs: [
        "--target-repo",
        "openclaw/openclaw",
        "--item-numbers",
        ascending.join(","),
        "--processed-limit",
        "1",
        "--cursor-trace",
        wrappedTracePath,
        "--comment-sync-cursor",
        "200000",
      ],
    });

    const wrappedReport = JSON.parse(readFileSync(wrappedReportPath, "utf8"));
    const wrappedTrace = JSON.parse(readFileSync(wrappedTracePath, "utf8"));
    assert.equal(wrappedReport[0]?.number, 87267);
    assert.deepEqual(wrappedTrace, { schema_version: 1, examined_item_numbers: [87267] });

    runApplyDecisionsForTest({
      itemsDir,
      closedDir,
      plansDir,
      reportPath: unsortedReportPath,
      extraArgs: [
        "--target-repo",
        "openclaw/openclaw",
        "--item-numbers",
        "105342,105870,87267,97566,95788",
        "--processed-limit",
        "1",
        "--cursor-trace",
        unsortedTracePath,
        "--comment-sync-cursor",
        "90000",
      ],
    });

    const unsortedReport = JSON.parse(readFileSync(unsortedReportPath, "utf8"));
    const unsortedTrace = JSON.parse(readFileSync(unsortedTracePath, "utf8"));
    assert.equal(unsortedReport[0]?.number, 95788);
    assert.deepEqual(unsortedTrace, { schema_version: 1, examined_item_numbers: [95788] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const mode of ["exact-event", "proof", "comment-sync", "broad", "empty"] as const) {
  test(`${mode} apply does not read unrelated canonical records`, () => {
    const root = mkdtempSync(tmpPrefix);
    try {
      const itemsDir = join(root, "items");
      const closedDir = join(root, "closed");
      const plansDir = join(root, "plans");
      const reportPath = join(root, "apply-report.json");
      mkdirSync(itemsDir, { recursive: true });
      mkdirSync(closedDir, { recursive: true });
      mkdirSync(plansDir, { recursive: true });
      writeFileSync(
        join(itemsDir, "20.md"),
        workPlanCandidateReport({
          repository: "openclaw/openclaw",
          number: 20,
          local_checkout_access: "unverified",
          decision: "keep_open",
          action_taken: "kept_open",
        }),
        "utf8",
      );
      if (mode !== "broad") {
        symlinkSync(join(root, "missing-record.md"), join(itemsDir, "999.md"));
      }
      symlinkSync(join(root, "missing-record.md"), join(closedDir, "998.md"));

      runApplyDecisionsForTest({
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: [
          "--target-repo",
          "openclaw/openclaw",
          "--skip-dashboard",
          ...(mode === "broad" ? [] : ["--item-numbers", mode === "empty" ? "21" : "20"]),
          ...(mode === "exact-event" ? ["--exact-event-publication"] : []),
          ...(mode === "proof" ? ["--dry-run"] : []),
          ...(mode === "comment-sync" ? ["--sync-comments-only"] : []),
          "--limit",
          "1",
        ],
      });

      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      if (mode === "empty") assert.deepEqual(report, []);
      else assert.equal(report[0]?.number, 20);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("apply-decisions keeps close-limit candidates out of the cursor trace", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const tracePath = join(root, "apply-cursor-trace.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const comments: Record<number, string> = {};
    for (const number of [10, 20]) {
      const synced = reportWithSyncedReviewComment(
        implementedCloseReport({ number }),
        number,
        "implemented_on_main",
      );
      writeFileSync(join(itemsDir, `${number}.md`), synced.report, "utf8");
      comments[number] = synced.comment;
    }

    const ghMock = `
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] === "-i" ? args[2] || "" : args[1] || "";
const comments = ${JSON.stringify(comments)};
if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/(10|20)\\/timeline(?:\\?|$)/.test(path)) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/(10|20)\\/comments(?:\\?|$)/.test(path)) {
  const number = Number(path.match(/\\/issues\\/(\\d+)\\/comments/)[1]);
  console.log(JSON.stringify([[
    {
      id: 9000 + number,
      html_url: "https://github.com/openclaw/clawsweeper/issues/" + number + "#issuecomment-" + (9000 + number),
      body: comments[number],
      user: { login: "github-actions[bot]" },
      created_at: "2026-05-01T01:00:00Z",
      updated_at: "2026-05-01T01:00:00Z"
    }
  ]]));
} else if (args[0] === "api" && /\\/issues\\/(10|20)$/.test(path)) {
  const number = Number(path.match(/\\/issues\\/(\\d+)$/)[1]);
  console.log(JSON.stringify({
    number,
    title: "Close limit trace " + number,
    html_url: "https://github.com/openclaw/clawsweeper/issues/" + number,
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
} else if (args[0] === "api" && path.startsWith("search/issues?")) {
  console.log(JSON.stringify({ items: [] }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
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
          "--limit",
          "1",
          "--processed-limit",
          "10",
          "--cursor-trace",
          tracePath,
        ],
      });
    });

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const trace = JSON.parse(readFileSync(tracePath, "utf8"));
    assert.deepEqual(
      report
        .filter((entry: { action: string }) => entry.action === "closed")
        .map((entry: { number: number }) => entry.number),
      [10],
    );
    assert.deepEqual(trace, { schema_version: 1, examined_item_numbers: [10] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
