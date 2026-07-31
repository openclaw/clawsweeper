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
    mkdirSync(bin);
    const pnpm = join(bin, "pnpm.mjs");
    const gh = join(bin, "gh.mjs");
    writeFileSync(
      pnpm,
      [
        "const args = process.argv.slice(2);",
        'if (args[2] === "workflow") {',
        '  process.stdout.write("2\\n");',
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
    ["--target-repo", "openclaw/openclaw", "--max-dispatch", "101"],
    ["--target-repo", "openclaw/openclaw", "--item-number", "../3"],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[issue-implementation-dispatch\]/);
  }
});
