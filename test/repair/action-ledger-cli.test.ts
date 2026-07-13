import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("action-ledger CLI accepts the package-manager argument separator", () => {
  const result = spawnSync(
    process.execPath,
    [path.resolve("dist/repair/action-ledger-cli.js"), "--", "finalize", "--lane", "INVALID"],
    { encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid command action ledger lane: INVALID/);
  assert.doesNotMatch(result.stderr, /unknown argument: finalize/);
});

test("action-ledger CLI accepts an explicitly empty finalization", () => {
  const outputRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "command-action-ledger-empty-")),
  );
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.resolve("dist/repair/action-ledger-cli.js"),
        "finalize",
        "--lane",
        "comment-router",
        "--allow-empty",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
          CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: outputRoot,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  } finally {
    fs.rmSync(outputRoot, { force: true, recursive: true });
  }
});
