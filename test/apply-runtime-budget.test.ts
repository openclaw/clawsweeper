import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  implementedCloseReport,
  runApplyDecisionsForTest,
  tmpPrefix,
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
