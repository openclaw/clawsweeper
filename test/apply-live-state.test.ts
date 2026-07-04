import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  implementedCloseReport,
  readText,
  runApplyDecisionsForTest,
  tmpPrefix,
  withMockGh,
} from "./helpers.ts";

test("apply-decisions archives records deleted after review instead of failing the run", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(itemsDir, "321.md"),
      implementedCloseReport({ action_taken: "proposed_close" }),
      "utf8",
    );

    const ghMock = `
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] || "";
if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.error("gh: Not Found (HTTP 404)");
  process.exit(1);
}
if (args[0] === "api" && path === "repos/openclaw/clawsweeper") {
  console.log(JSON.stringify({ full_name: "openclaw/clawsweeper" }));
  process.exit(0);
}
console.error("unexpected gh args", JSON.stringify(args));
process.exit(1);
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({ itemsDir, closedDir, plansDir, reportPath });
    });

    assert.equal(existsSync(join(itemsDir, "321.md")), false);
    assert.ok(existsSync(join(closedDir, "321.md")));
    assert.match(readText(join(closedDir, "321.md")), /^action_taken: skipped_already_closed$/m);
    assert.deepEqual(JSON.parse(readText(reportPath)), [
      {
        number: 321,
        action: "skipped_already_closed",
        reason: "item not found on GitHub",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions keeps missing records queued during comment-only sync", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(itemsDir, "321.md"), implementedCloseReport(), "utf8");

    const ghMock = `
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] || "";
if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.error("gh: Not Found (HTTP 404)");
  process.exit(1);
}
if (args[0] === "api" && path === "repos/openclaw/clawsweeper") {
  console.log(JSON.stringify({ full_name: "openclaw/clawsweeper" }));
  process.exit(0);
}
console.error("unexpected gh args", JSON.stringify(args));
process.exit(1);
`;
    withMockGh(root, ghMock, () => {
      runApplyDecisionsForTest({
        itemsDir,
        closedDir,
        plansDir,
        reportPath,
        extraArgs: ["--sync-comments-only"],
      });
    });

    assert.ok(existsSync(join(itemsDir, "321.md")));
    assert.equal(existsSync(join(closedDir, "321.md")), false);
    assert.match(readText(join(itemsDir, "321.md")), /^action_taken: proposed_close$/m);
    assert.deepEqual(JSON.parse(readText(reportPath)), [
      {
        number: 321,
        action: "skipped_already_closed",
        reason: "item not found on GitHub",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply-decisions fails safely when a missing repository also returns 404", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(itemsDir, "321.md"), implementedCloseReport(), "utf8");

    const ghMock = `
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] || "";
if (args[0] === "api" && (/\\/issues\\/321$/.test(path) || path === "repos/openclaw/clawsweeper")) {
  console.error("gh: Not Found (HTTP 404)");
  process.exit(1);
}
console.error("unexpected gh args", JSON.stringify(args));
process.exit(1);
`;
    assert.throws(
      () =>
        withMockGh(root, ghMock, () => {
          runApplyDecisionsForTest({ itemsDir, closedDir, plansDir, reportPath });
        }),
      /Not Found/,
    );

    assert.ok(existsSync(join(itemsDir, "321.md")));
    assert.equal(existsSync(join(closedDir, "321.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
