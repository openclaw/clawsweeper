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

const SANDBOX_FAILURE =
  "Inspection infrastructure failure: the only permitted local read command failed before opening repository files: `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`. Consequently, current-main source, history, and dependency contracts were not independently inspected.";

test("apply withholds close when the review reports a blocked local checkout", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });

    const synced = reportWithSyncedReviewComment(
      implementedCloseReport({ number: 10 }),
      10,
      "implemented_on_main",
    );
    // The review record keeps the front-matter value the review writer always emits.
    assert.match(synced.report, /^local_checkout_access: verified$/m);
    writeFileSync(join(itemsDir, "10.md"), `${synced.report}\n${SANDBOX_FAILURE}\n`, "utf8");

    const ghMock = `
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] === "-i" ? args[2] || "" : args[1] || "";
const comment = ${JSON.stringify(synced.comment)};
if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/10\\/timeline(?:\\?|$)/.test(path)) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/10\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[
    {
      id: 9010,
      html_url: "https://github.com/openclaw/clawsweeper/issues/10#issuecomment-9010",
      body: comment,
      user: { login: "github-actions[bot]" },
      created_at: "2026-05-01T01:00:00Z",
      updated_at: "2026-05-01T01:00:00Z"
    }
  ]]));
} else if (args[0] === "api" && /\\/issues\\/10$/.test(path)) {
  console.log(JSON.stringify({
    number: 10,
    title: "Blocked local checkout",
    html_url: "https://github.com/openclaw/clawsweeper/issues/10",
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
        extraArgs: ["--dry-run", "--item-numbers", "10", "--processed-limit", "2"],
      });
    });

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.deepEqual(report, [
      {
        number: 10,
        action: "kept_open",
        reason: "review lacks verified local checkout access",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
