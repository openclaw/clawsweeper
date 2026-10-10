import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = "scripts/dispatch-issue-implementation-candidates.mjs";

test("automatic issue dispatcher filters exact issues and preserves bounded backfill", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-issue-dispatch-"));
  try {
    const bin = join(root, "bin");
    const log = join(root, "dispatch.log");
    const healthLog = join(root, "health.log");
    writeFileSync(healthLog, "");
    mkdirSync(bin);
    const pnpm = join(bin, "pnpm.mjs");
    const gh = join(bin, "gh.mjs");
    writeFileSync(
      pnpm,
      [
        'import { appendFileSync } from "node:fs";',
        "const args = process.argv.slice(2);",
        'if (args[2] === "workflow") {',
        '  process.stdout.write("2\\n");',
        "  process.exit(0);",
        "}",
        'if (args[4] === "lane-health") {',
        '  appendFileSync(process.env.HEALTH_LOG, args.slice(5).join(" ") + "\\n");',
        "  process.stdout.write(process.env.FAKE_HEALTH || JSON.stringify({ paused: false, notice: null }));",
        "  process.exit(0);",
        "}",
        'if (process.env.NO_CANDIDATES === "1") {',
        '  process.stdout.write(JSON.stringify({ candidates: [] }) + "\\n");',
        "  process.exit(0);",
        "}",
        "process.stdout.write(JSON.stringify({ candidates: [",
        '  { item_number: 41, report_path: "records/openclaw-openclaw/items/41.md", report_url: "https://example.test/41" },',
        '  { item_number: 42, report_path: "records/openclaw-openclaw/items/42.md", report_url: "https://example.test/42" },',
        '  { item_number: 43, report_path: "records/openclaw-openclaw/items/43.md", report_url: "https://example.test/43" },',
        '] }) + "\\n");',
      ].join("\n"),
    );
    writeFileSync(
      gh,
      [
        'import { appendFileSync } from "node:fs";',
        'appendFileSync(process.env.DISPATCH_LOG, process.argv.slice(2).join(" ") + "\\n");',
        'process.exit(process.env.FAIL_GH === "1" ? 9 : 0);',
      ].join("\n"),
    );
    const env = {
      ...process.env,
      GH_BIN: process.execPath,
      GH_BIN_ARGS: JSON.stringify([gh]),
      PNPM_BIN: process.execPath,
      PNPM_BIN_ARGS: JSON.stringify([pnpm]),
      DISPATCH_LOG: log,
      HEALTH_LOG: healthLog,
      GITHUB_REPOSITORY: "openclaw/clawsweeper",
    };

    const exact = execFileSync(
      process.execPath,
      [
        script,
        "--target-repo",
        "openclaw/openclaw",
        "--item-number",
        "42",
        "--artifact-dir",
        "/tmp/reports",
      ],
      { encoding: "utf8", env },
    );
    assert.match(exact, /"dispatched":1/);
    assert.match(exact, /https:\/\/github\.com\/openclaw\/openclaw\/issues\/42/);
    assert.match(readFileSync(log, "utf8"), /item_number=42/);
    assert.doesNotMatch(readFileSync(log, "utf8"), /item_number=41/);

    writeFileSync(log, "");
    const backfill = execFileSync(
      process.execPath,
      [script, "--target-repo", "openclaw/openclaw", "--report-dir", "/tmp/reports"],
      { encoding: "utf8", env },
    );
    assert.match(backfill, /"dispatched":2/);
    assert.match(readFileSync(log, "utf8"), /item_number=41/);
    assert.match(readFileSync(log, "utf8"), /item_number=42/);
    assert.doesNotMatch(readFileSync(log, "utf8"), /item_number=43/);

    writeFileSync(log, "");
    const paused = execFileSync(
      process.execPath,
      [script, "--target-repo", "openclaw/openclaw", "--max-dispatch", "0"],
      { encoding: "utf8", env },
    );
    assert.deepEqual(JSON.parse(paused), { discovered: 0, dispatched: 0 });
    assert.equal(readFileSync(log, "utf8"), "");
    assert.equal(readFileSync(healthLog, "utf8"), "--target-repo openclaw/openclaw\n".repeat(2));

    writeFileSync(healthLog, "");
    execFileSync(process.execPath, [script, "--target-repo", "openclaw/openclaw"], {
      encoding: "utf8",
      env: { ...env, NO_CANDIDATES: "1" },
    });
    assert.equal(readFileSync(healthLog, "utf8"), "", "no candidate means no health read");

    const notice =
      "Automatic issue implementation for openclaw/openclaw is paused: 2 of 10 finished worker runs succeeded.";
    const pausedByHealth = execFileSync(
      process.execPath,
      [script, "--target-repo", "openclaw/openclaw", "--report-dir", "/tmp/reports"],
      {
        encoding: "utf8",
        env: {
          ...env,
          MIN_SUCCESS_PERCENT: "70",
          FAKE_HEALTH: JSON.stringify({ paused: true, notice }),
        },
      },
    );
    assert.equal(readFileSync(log, "utf8"), "", "a paused lane dispatches nothing");
    assert.equal(
      readFileSync(healthLog, "utf8"),
      "--target-repo openclaw/openclaw --min-success-percent 70\n",
    );
    const pausedLines = pausedByHealth.trim().split("\n");
    assert.deepEqual(pausedLines, [
      `::warning title=Automatic issue implementation paused::${notice}`,
      JSON.stringify({ discovered: 3, dispatched: 0, paused: true }),
    ]);

    const invalidHealth = spawnSync(
      process.execPath,
      [script, "--target-repo", "openclaw/openclaw", "--item-number", "42"],
      { encoding: "utf8", env: { ...env, FAKE_HEALTH: JSON.stringify({ notice: null }) } },
    );
    assert.equal(invalidHealth.status, 1);
    assert.match(invalidHealth.stderr, /lane health returned no pause decision/);
    assert.equal(readFileSync(log, "utf8"), "");

    const failed = spawnSync(
      process.execPath,
      [script, "--target-repo", "openclaw/openclaw", "--item-number", "42"],
      { encoding: "utf8", env: { ...env, FAIL_GH: "1" } },
    );
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /gh exited 9/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("automatic issue dispatcher rejects unsafe repositories and unbounded limits", () => {
  for (const args of [
    ["--target-repo", "openclaw/openclaw;bad"],
    ["--target-repo", "openclaw/openclaw", "--candidate-kind", "unknown"],
    ["--target-repo", "openclaw/openclaw", "--max-dispatch", "101"],
    ["--target-repo", "openclaw/openclaw", "--item-number", "../3"],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[issue-implementation-dispatch\]/);
  }
});

test("planner implementation backfill uses compiled discovery for both retained candidate classes", () => {
  const receipt = JSON.parse(
    execFileSync(process.execPath, ["scripts/e2e/implementation-backfill.mjs"], {
      encoding: "utf8",
      timeout: 30_000,
    }),
  );
  assert.equal(receipt.ok, true);
  assert.deepEqual(
    receipt.results.map((entry) => entry.kind),
    ["vision_fit", "viable"],
  );
});
