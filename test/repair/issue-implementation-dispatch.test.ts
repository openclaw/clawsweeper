import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    writeExecutable(
      join(bin, "pnpm"),
      `#!/bin/sh
if [ "$3" = "workflow" ]; then printf '2\\n'; exit 0; fi
printf '%s\\n' '{"candidates":[{"item_number":41,"report_path":"records/openclaw-openclaw/items/41.md","report_url":"https://example.test/41"},{"item_number":42,"report_path":"records/openclaw-openclaw/items/42.md","report_url":"https://example.test/42"},{"item_number":43,"report_path":"records/openclaw-openclaw/items/43.md","report_url":"https://example.test/43"}]}'
`,
    );
    writeExecutable(
      join(bin, "gh"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$DISPATCH_LOG"
if [ "$FAIL_GH" = "1" ]; then exit 9; fi
`,
    );
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
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

function writeExecutable(path: string, content: string) {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}
