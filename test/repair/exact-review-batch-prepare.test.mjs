import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { runBoundedPool } from "../../scripts/prepare-exact-review-batch.mjs";

test("bounded preparation pool respects the configured concurrency", async () => {
  let active = 0;
  let peak = 0;
  const result = await runBoundedPool([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.equal(peak, 2);
  assert.equal(result.peak, 2);
  assert.deepEqual(result.results, [2, 4, 6, 8, 10]);
});

test("batch preparation copies canonical records without cloning git state", () => {
  const source = readFileSync("scripts/prepare-exact-review-batch.mjs", "utf8");
  assert.match(source, /cpSync\(recordsSource, join\(root, "records"\)/);
  assert.doesNotMatch(source, /CLAWSWEEPER_STATE_DIR|stateClone|git["'], \["clone"/);
  assert.doesNotMatch(source, /pack-objects|unpack-objects|targetOid|expectedOid/);
});
