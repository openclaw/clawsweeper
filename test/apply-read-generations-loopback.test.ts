import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("apply read-generation loopback proof preserves mutation barriers", () => {
  const output = execFileSync(
    process.execPath,
    ["scripts/e2e/apply-read-generations-loopback.mjs"],
    { encoding: "utf8" },
  );
  const result = JSON.parse(output);
  assert.deepEqual(result.counted_formula, {
    before: "F(1)+C(4)+P(6)+L(3)=14",
    after: "U(6)+L_live(3)=9",
  });
  assert.equal(result.concurrent_head_blocked, true);
  assert.equal(result.concurrent_comment_blocked, true);
  assert.deepEqual(result.validated_snapshot_list_reads, {
    files: 0,
    commits: 0,
    inline_comments: 0,
  });
});
