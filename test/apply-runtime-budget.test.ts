import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  implementedCloseReport,
  lowSignalCloseReport,
  promotionGhMock,
  reportWithSyncedReviewComment,
  runApplyDecisionsForTest,
  tmpPrefix,
  withMockCodexProof,
  withMockGh,
} from "./helpers.ts";

function runtimeBudgetFixture(number: number) {
  const root = mkdtempSync(tmpPrefix);
  const itemsDir = join(root, "items");
  const closedDir = join(root, "closed");
  const plansDir = join(root, "plans");
  const reportPath = join(root, "apply-report.json");
  const cursorTracePath = join(root, "apply-cursor-trace.json");
  mkdirSync(itemsDir, { recursive: true });
  mkdirSync(plansDir, { recursive: true });
  writeFileSync(join(itemsDir, `${number}.md`), implementedCloseReport({ number }), "utf8");
  return { root, itemsDir, closedDir, plansDir, reportPath, cursorTracePath };
}

function assertRuntimeYield(
  fixture: ReturnType<typeof runtimeBudgetFixture>,
  maxRuntimeMs: number,
) {
  const report = JSON.parse(readFileSync(fixture.reportPath, "utf8"));
  const cursorTrace = JSON.parse(readFileSync(fixture.cursorTracePath, "utf8"));
  assert.deepEqual(report, [
    {
      number: 0,
      action: "skipped_runtime_budget",
      reason: report[0]?.reason,
    },
  ]);
  assert.match(report[0]?.reason ?? "", new RegExp(`max runtime ${maxRuntimeMs}ms reached`));
  assert.deepEqual(cursorTrace, { schema_version: 1, examined_item_numbers: [] });
}

test("apply-decisions bounds a hung GitHub command and writes a resumable runtime yield", () => {
  const fixture = runtimeBudgetFixture(721);
  const maxRuntimeMs = 2_200;
  try {
    const startedAt = Date.now();
    withMockGh(fixture.root, "setTimeout(() => {}, 10_000);", () => {
      runApplyDecisionsForTest({
        ...fixture,
        extraArgs: [
          "--max-runtime-ms",
          String(maxRuntimeMs),
          "--cursor-trace",
          fixture.cursorTracePath,
        ],
      });
    });

    assert.ok(Date.now() - startedAt < 4_000, "hung gh command exceeded the apply runtime bound");
    assertRuntimeYield(fixture, maxRuntimeMs);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("apply-decisions yields instead of starting a GitHub retry that cannot fit", () => {
  const fixture = runtimeBudgetFixture(722);
  const maxRuntimeMs = 2_500;
  try {
    const startedAt = Date.now();
    withMockGh(fixture.root, 'console.error("service unavailable"); process.exit(1);', () => {
      runApplyDecisionsForTest({
        ...fixture,
        extraArgs: [
          "--max-runtime-ms",
          String(maxRuntimeMs),
          "--cursor-trace",
          fixture.cursorTracePath,
        ],
      });
    });

    assert.ok(Date.now() - startedAt < 2_000, "GitHub retry sleep ignored the remaining runtime");
    assertRuntimeYield(fixture, maxRuntimeMs);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("apply-decisions preserves a runtime yield through post-proof freshness handling", () => {
  const fixture = runtimeBudgetFixture(723);
  const maxRuntimeMs = 3_000;
  const proofLogPath = join(fixture.root, "proof.log");
  const synced = reportWithSyncedReviewComment(
    lowSignalCloseReport({
      number: 723,
      title: "Provider route fallback",
      close_reason: "duplicate_or_superseded",
      work_cluster_refs: JSON.stringify([
        "Superseded by https://github.com/openclaw/openclaw/pull/400",
      ]),
    }).replace(
      "Closing this PR because the branch is not a useful landing base.",
      "Closing this PR as superseded by https://github.com/openclaw/openclaw/pull/400.",
    ),
    723,
    "duplicate_or_superseded",
  );
  writeFileSync(join(fixture.itemsDir, "723.md"), synced.report, "utf8");
  try {
    withMockGh(
      fixture.root,
      promotionGhMock({
        number: 723,
        title: "Provider route fallback",
        comment: synced.comment,
        itemUpdatedAtAfterProofLogPath: proofLogPath,
        linkedPullHangAfterProof: true,
        linkedPulls: {
          400: {
            number: 400,
            title: "Provider cleanup",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "closed",
            merged_at: "2026-05-02T00:00:00Z",
            updated_at: "2026-05-01T00:00:00Z",
            body: "Includes the fallback route behavior from PR 723.",
            comments: [],
            labels: [],
          },
        },
      }),
      () => {
        withMockCodexProof(
          fixture.root,
          {
            type: "decision",
            decision: "covered",
            reason: "PR B carries forward PR A's fallback route behavior.",
            invocationLogPath: proofLogPath,
          },
          () => {
            runApplyDecisionsForTest({
              ...fixture,
              targetRepo: "openclaw/openclaw",
              extraArgs: [
                "--apply-kind",
                "all",
                "--max-runtime-ms",
                String(maxRuntimeMs),
                "--cursor-trace",
                fixture.cursorTracePath,
              ],
            });
          },
        );
      },
    );

    assertRuntimeYield(fixture, maxRuntimeMs);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
