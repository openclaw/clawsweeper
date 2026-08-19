import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("GraphQL activity cursor v2 loopback proves request reductions and fallback", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/e2e/graphql-activity-cursor-v2-loopback.mjs"],
    {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout.trim());
  assert.deepEqual(receipt.requests.single, { v1: 6, v2: 2 });
  assert.deepEqual(receipt.requests.batch, { v1: 48, v2: 2 });
  assert.equal(receipt.assertions.fallback_decision_unchanged, true);
  assert.equal(receipt.assertions.fallback_telemetry_lines, 1);
  assert.equal(receipt.assertions.concurrent_change_unstable, true);
});
