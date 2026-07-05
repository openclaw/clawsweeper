import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { runApplyDecisionsForTest, tmpPrefix, workPlanCandidateReport } from "./helpers.ts";

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
