import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { reportFrontMatter, tmpPrefix, withReviewRecord } from "./helpers.ts";

test("audit health does not retain the source of thousands of large reports", (t) => {
  const root = mkdtempSync(tmpPrefix);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const itemsDir = join(root, "items");
  const closedDir = join(root, "closed");
  mkdirSync(itemsDir);
  mkdirSync(closedDir);

  const report = reportFrontMatter({
    number: 1,
    title: "Audit memory regression report with a long title",
    reviewed_at: "2026-08-01T12:00:00.000Z",
    review_status: "complete",
    current_state: "open",
  });
  const sources = [report, withReviewRecord(report)].map((markdown, index) => {
    const path = join(root, `source-${index}.md`);
    writeFileSync(path, `${markdown}\n## Evidence\n\n${"e".repeat(64 * 1024)}\n`);
    return path;
  });
  // Hardlinks use little disk space, but readFileSync creates a fresh source
  // string for every report. Retaining their metadata slices exceeds the child
  // heap: 2,048 reports have more than 128 MiB of otherwise irrelevant bodies.
  const reportCount = 2048;
  for (let number = 1; number <= reportCount; number += 1) {
    linkSync(sources[number % sources.length]!, join(itemsDir, `${number}.md`));
  }

  const moduleUrl = new URL("../dist/clawsweeper-dashboard-audit.js", import.meta.url).href;
  const script = `
    import { createDashboardAudit } from ${JSON.stringify(moduleUrl)};
    const audit = createDashboardAudit({
      repoFromArgs: () => {},
      defaultItemsDir: () => ${JSON.stringify(itemsDir)},
      defaultClosedDir: () => ${JSON.stringify(closedDir)},
      targetRepo: () => "openclaw/openclaw",
      repoRelativePath: path => path,
      fetchOpenItems: () => ({ items: [], pagesScanned: 1, complete: true }),
      applyBlockingProtectedLabels: () => [],
      displayTitle: String,
    });
    audit.auditCommand({ sample_limit: "0" });
  `;
  const stdout = execFileSync(
    process.execPath,
    ["--max-old-space-size=64", "--input-type=module", "--eval", script],
    { encoding: "utf8", timeout: 60_000 },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.targetRepo, "openclaw/openclaw");
  assert.equal(result.counts.itemRecords, reportCount);
  assert.equal(result.counts.staleItemRecords, reportCount);
  assert.equal(result.counts.closedRecords, 0);
  assert.deepEqual(result.findings.staleItemRecords, []);
});
