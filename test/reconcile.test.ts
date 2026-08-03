import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { capturedCanonicalRecordBaselineKeys } from "../dist/repair/canonical-record-baseline.js";
import { reportFrontMatter, tmpPrefix, withMockGh } from "./helpers.ts";

test("scoped reconciliation never changes records outside its selected batch", () => {
  const root = mkdtempSync(tmpPrefix);
  const recordsDir = join(root, "records", "openclaw-openclaw");
  const itemsDir = join(recordsDir, "items");
  const closedDir = join(recordsDir, "closed");
  const plansDir = join(recordsDir, "plans");
  const canonicalBaselineDir = join(root, "canonical-baseline");
  for (const dir of [itemsDir, closedDir, plansDir]) {
    mkdirSync(dir, { recursive: true });
  }
  const report = (number: number, currentState: "open" | "closed") =>
    reportFrontMatter({ number, current_state: currentState });
  writeFileSync(join(itemsDir, "1.md"), report(1, "open"));
  writeFileSync(join(itemsDir, "2.md"), report(2, "open"));
  writeFileSync(join(closedDir, "3.md"), report(3, "closed"));
  const unrelatedPlan = "preserve unrelated closed sidecar\n";
  writeFileSync(join(plansDir, "3.md"), unrelatedPlan);
  const ghMock = `
const args = process.argv.slice(2);
if (args[0] === "api" && args[1]?.endsWith("/issues/2")) {
  process.stdout.write(JSON.stringify({number:2,state:"closed",closed_at:"2026-08-02T00:00:00Z"}));
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
          "--canonical-record-baseline-dir",
          canonicalBaselineDir,
          "--skip-closed-at",
          "--item-numbers",
          "2",
          "--only-item-numbers",
        ],
        { encoding: "utf8" },
      );
    });

    const result = JSON.parse(stdout);
    assert.equal(result.pagesScanned, 0);
    assert.deepEqual(result.changedItemNumbers, [2]);
    assert.deepEqual(result.changedRecordFiles, ["2.md"]);
    assert.equal(existsSync(join(itemsDir, "1.md")), true);
    assert.equal(existsSync(join(closedDir, "1.md")), false);
    assert.equal(existsSync(join(itemsDir, "2.md")), false);
    assert.equal(existsSync(join(closedDir, "2.md")), true);
    assert.equal(readFileSync(join(plansDir, "3.md"), "utf8"), unrelatedPlan);
    assert.deepEqual(
      [...capturedCanonicalRecordBaselineKeys(canonicalBaselineDir)],
      ["openclaw-openclaw/2"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scoped reconciliation archives a deleted item only after confirming repository access", () => {
  const root = mkdtempSync(tmpPrefix);
  const itemsDir = join(root, "items");
  const closedDir = join(root, "closed");
  const plansDir = join(root, "plans");
  for (const dir of [itemsDir, closedDir, plansDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(itemsDir, "41.md"), reportFrontMatter({ number: 41, current_state: "open" }));
  const ghMock = `
const args = process.argv.slice(2);
if (args[0] === "api" && args[1] === "repos/openclaw/openclaw/issues/41") {
  process.stderr.write("gh: Not Found (HTTP 404)\\n");
  process.exit(1);
}
if (args[0] === "api" && args[1] === "repos/openclaw/openclaw") {
  process.stdout.write(JSON.stringify({id:41}));
  process.exit(0);
}
process.stderr.write("unexpected gh args: " + JSON.stringify(args) + "\\n");
process.exit(1);
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
          "--skip-closed-at",
          "--item-numbers",
          "41",
          "--only-item-numbers",
        ],
        { encoding: "utf8" },
      );
    });

    const result = JSON.parse(stdout);
    assert.equal(result.pagesScanned, 0);
    assert.equal(result.movedToClosed, 1);
    assert.deepEqual(result.changedItemNumbers, [41]);
    assert.equal(existsSync(join(itemsDir, "41.md")), false);
    assert.equal(existsSync(join(closedDir, "41.md")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scoped reconciliation never archives an item when repository access is missing", () => {
  const root = mkdtempSync(tmpPrefix);
  const itemsDir = join(root, "items");
  const closedDir = join(root, "closed");
  const plansDir = join(root, "plans");
  for (const dir of [itemsDir, closedDir, plansDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(itemsDir, "41.md"), reportFrontMatter({ number: 41, current_state: "open" }));
  const ghMock = `
process.stderr.write("gh: Not Found (HTTP 404)\\n");
process.exit(1);
`;

  try {
    withMockGh(root, ghMock, () => {
      assert.throws(() =>
        execFileSync(
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
            "--skip-closed-at",
            "--item-numbers",
            "41",
            "--only-item-numbers",
          ],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        ),
      );
    });
    assert.equal(existsSync(join(itemsDir, "41.md")), true);
    assert.equal(existsSync(join(closedDir, "41.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconcile reports every changed record tuple and cleans already-closed sidecars", () => {
  const root = mkdtempSync(tmpPrefix);
  const recordsDir = join(root, "records", "openclaw-openclaw");
  const itemsDir = join(recordsDir, "items");
  const closedDir = join(recordsDir, "closed");
  const plansDir = join(recordsDir, "plans");
  const packetsDir = join(recordsDir, "decision-packets");
  const canonicalBaselineDir = join(root, "canonical-baseline");
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
          "--canonical-record-baseline-dir",
          canonicalBaselineDir,
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
    assert.equal(
      readFileSync(join(canonicalBaselineDir, "records/openclaw-openclaw/items/1.md"), "utf8"),
      report(1, "open"),
    );
    assert.equal(
      readFileSync(join(canonicalBaselineDir, "records/openclaw-openclaw/plans/1.md"), "utf8"),
      "stale plan for newly closed item\n",
    );
    assert.equal(
      existsSync(join(canonicalBaselineDir, "records/openclaw-openclaw/closed/1.md")),
      false,
    );
    assert.equal(
      readFileSync(
        join(canonicalBaselineDir, "records/openclaw-openclaw/decision-packets/5.json"),
        "utf8",
      ),
      '{"subject":{"state":"open"}}\n',
    );
    assert.deepEqual([...capturedCanonicalRecordBaselineKeys(canonicalBaselineDir)].sort(), [
      "openclaw-openclaw/1",
      "openclaw-openclaw/2",
      "openclaw-openclaw/3",
      "openclaw-openclaw/4",
      "openclaw-openclaw/5",
      "openclaw-openclaw/7",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
