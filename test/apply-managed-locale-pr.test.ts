import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  promotionGhMock,
  reportWithSyncedReviewComment,
  runOpenClawApplyDecisionsForTest,
  withApplyTestWorkspace,
  withMockGh,
  workPlanCandidateReport,
} from "./helpers.ts";

for (const branch of [
  "automation/native-app-locale-refresh",
  "automation/control-ui-locale-refresh",
]) {
  test(`apply leaves the publisher-owned ${branch} PR open`, () => {
    withApplyTestWorkspace("/tmp/clawsweeper-managed-locale-", (workspace) => {
      const number = 333;
      const author = "openclaw-mantis[bot]";
      const report =
        workPlanCandidateReport({
          repository: "openclaw/openclaw",
          number,
          type: "pull_request",
          title: "Generated locale refresh",
          author,
          author_association: "NONE",
          decision: "close",
          close_reason: "incoherent",
          action_taken: "proposed_close",
          confidence: "high",
          item_snapshot_hash: "reviewed-snapshot",
          item_created_at: "2026-02-01T00:00:00Z",
          item_updated_at: "2026-05-01T00:00:00Z",
          reviewed_at: "2026-05-01T00:00:00Z",
          labels: "[]",
        }) +
        "\n## Evidence\n\n- **review:** Prior review proposes closure.\n\n## Close Comment\n\nClose this generated update.\n";
      const synced = reportWithSyncedReviewComment(report, number, "incoherent");
      writeFileSync(join(workspace.itemsDir, `${number}.md`), synced.report);
      const closeLog = join(workspace.root, "close.log");
      withMockGh(
        workspace.root,
        promotionGhMock({
          number,
          title: "Generated locale refresh",
          authorLogin: author,
          authorAssociation: "NONE",
          labels: [],
          headRef: branch,
          headRepository: "openclaw/openclaw",
          comment: synced.comment,
          closeCommandLogPath: closeLog,
        }),
        () =>
          runOpenClawApplyDecisionsForTest({
            ...workspace,
            dryRun: true,
            extraArgs: ["--skip-dashboard", "--item-number", String(number)],
          }),
      );
      const results = JSON.parse(readFileSync(workspace.reportPath, "utf8"));
      assert(
        results.some(
          (result: { action: string; reason: string }) =>
            result.action === "kept_open" && result.reason.includes("repository-managed locale"),
        ),
        JSON.stringify(results),
      );
      assert.equal(existsSync(closeLog), false);
      assert.equal(existsSync(join(workspace.itemsDir, `${number}.md`)), true);
    });
  });
}
