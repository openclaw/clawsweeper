import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
