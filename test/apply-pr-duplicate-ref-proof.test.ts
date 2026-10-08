import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  lowSignalCloseReport,
  promotionGhMock,
  reportWithSyncedReviewComment,
  runOpenClawApplyDecisionsForTest,
  tmpPrefix,
  withApplyTestWorkspace,
  withMockCodexProof,
  withMockGh,
} from "./helpers.ts";

test("apply-decisions ignores bare refs inside cross-repo markdown link labels for duplicate proof", () => {
  withApplyTestWorkspace(tmpPrefix, ({ root, itemsDir, closedDir, plansDir, reportPath }) => {
    const proofLogPath = join(root, "proof.log");
    const synced = reportWithSyncedReviewComment(
      lowSignalCloseReport({
        number: 357,
        title: "Provider route fallback",
        close_reason: "duplicate_or_superseded",
        work_cluster_refs: JSON.stringify([
          "Superseded by [PR #400](https://github.com/other/repo/pull/400)",
        ]),
      }).replace(
        "Closing this PR because the branch is not a useful landing base.",
        "Closing this PR as superseded by the linked external PR.",
      ),
      357,
      "duplicate_or_superseded",
    );
    writeFileSync(join(itemsDir, "357.md"), synced.report, "utf8");

    withMockGh(
      root,
      promotionGhMock({
        number: 357,
        title: "Provider route fallback",
        comment: synced.comment,
        linkedPulls: {
          400: {
            number: 400,
            title: "Unrelated same-repo PR",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "closed",
            merged_at: "2026-05-02T00:00:00Z",
            body: "Unrelated provider cleanup.",
            comments: [],
            labels: [],
          },
        },
      }),
      () => {
        withMockCodexProof(
          root,
          {
            type: "failure",
            message: "coverage proof should not run for cross-repo markdown link labels",
            invocationLogPath: proofLogPath,
          },
          () => {
            runOpenClawApplyDecisionsForTest({
              itemsDir,
              closedDir,
              plansDir,
              reportPath,
              dryRun: true,
            });
          },
        );
      },
    );

    assert.equal(existsSync(proofLogPath), false);
  });
});
