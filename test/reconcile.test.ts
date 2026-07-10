import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { reportFrontMatter, tmpPrefix, withMockGh } from "./helpers.ts";

test("reconcile reports every changed record tuple and cleans already-closed sidecars", () => {
  const root = mkdtempSync(tmpPrefix);
  const recordsDir = join(root, "records", "openclaw-openclaw");
  const itemsDir = join(recordsDir, "items");
  const closedDir = join(recordsDir, "closed");
  const plansDir = join(recordsDir, "plans");
  const packetsDir = join(recordsDir, "decision-packets");
  for (const dir of [itemsDir, closedDir, plansDir, packetsDir]) {
    mkdirSync(dir, { recursive: true });
  }

  const report = (number: number, currentState: "open" | "closed", extra = {}) =>
    reportFrontMatter({
      number,
      current_state: currentState,
      decision_packet_path: "none",
      decision_packet_sha256: "none",
      ...extra,
    });

  writeFileSync(join(itemsDir, "1.md"), report(1, "open"));
  writeFileSync(join(plansDir, "1.md"), "stale plan for newly closed item\n");
  writeFileSync(join(closedDir, "2.md"), report(2, "closed"));
  writeFileSync(join(itemsDir, "3.md"), report(3, "open"));
  writeFileSync(join(closedDir, "3.md"), report(3, "closed"));
  const staleReconciledAt = "2026-07-01T00:00:00.000Z";
  writeFileSync(join(closedDir, "4.md"), report(4, "closed", { reconciled_at: staleReconciledAt }));
  writeFileSync(join(plansDir, "4.md"), "stale plan for closed item\n");
  writeFileSync(
    join(closedDir, "5.md"),
    report(5, "closed", {
      reconciled_at: staleReconciledAt,
      decision_packet_path: "records/openclaw-openclaw/decision-packets/5.json",
      decision_packet_sha256: "stale",
    }),
  );
  writeFileSync(join(packetsDir, "5.json"), '{"subject":{"state":"open"}}\n');
  writeFileSync(join(closedDir, "6.md"), report(6, "closed"));
  writeFileSync(join(itemsDir, "openclaw-openclaw-7.md"), report(7, "open"));

  const openItems = [2, 3].map((number) => ({
    number,
    title: `Open item ${number}`,
    html_url: `https://github.com/openclaw/openclaw/issues/${number}`,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    author_association: "CONTRIBUTOR",
    user: { login: "contributor" },
    labels: [],
    pull_request: null,
  }));
  const ghMock = `
const args = process.argv.slice(2);
if (args[0] === "api" && args[1]?.includes("/issues?state=open")) {
  process.stdout.write(${JSON.stringify(openItems.map((item) => JSON.stringify(item)).join("\n"))});
} else {
  process.stderr.write("unexpected gh args: " + JSON.stringify(args) + "\\n");
  process.exit(1);
}
`;

  try {
    let stdout = "";
    withMockGh(root, ghMock, () => {
      stdout = execFileSync(
        process.execPath,
        [
          "dist/clawsweeper.js",
          "reconcile",
          "--target-repo",
          "openclaw/openclaw",
          "--items-dir",
          itemsDir,
          "--closed-dir",
          closedDir,
          "--plans-dir",
          plansDir,
          "--decision-packets-dir",
          packetsDir,
          "--skip-closed-at",
        ],
        { encoding: "utf8" },
      );
    });

    const result = JSON.parse(stdout);
    assert.deepEqual(result.changedItemNumbers, [1, 2, 3, 4, 5, 7]);
    assert.deepEqual(result.changedRecordFiles, [
      "1.md",
      "2.md",
      "3.md",
      "4.md",
      "5.md",
      "openclaw-openclaw-7.md",
    ]);
    assert.equal(result.movedToClosed, 2);
    assert.equal(result.movedToItems, 1);
    assert.equal(result.removedStaleClosedCopies, 1);
    assert.equal(existsSync(join(closedDir, "1.md")), true);
    assert.equal(existsSync(join(itemsDir, "2.md")), true);
    assert.equal(existsSync(join(closedDir, "3.md")), false);
    assert.equal(existsSync(join(plansDir, "1.md")), false);
    assert.equal(existsSync(join(plansDir, "4.md")), false);
    assert.equal(existsSync(join(packetsDir, "5.json")), false);
    for (const number of [4, 5]) {
      const reconciledMarkdown = readFileSync(join(closedDir, `${number}.md`), "utf8");
      assert.doesNotMatch(
        reconciledMarkdown,
        new RegExp(`^reconciled_at: ${staleReconciledAt}$`, "m"),
      );
      assert.match(reconciledMarkdown, /^current_state: closed$/m);
    }
    assert.match(readFileSync(join(closedDir, "5.md"), "utf8"), /^decision_packet_path: none$/m);
    assert.equal(existsSync(join(closedDir, "6.md")), true);
    assert.equal(existsSync(join(closedDir, "openclaw-openclaw-7.md")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
