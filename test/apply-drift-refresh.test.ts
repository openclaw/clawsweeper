import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("default apply drift refresh executes queue-only ingress with bounded selection and live guards", () => {
  const result = spawnSync(process.execPath, ["scripts/e2e/apply-drift-refresh.ts"], {
    encoding: "utf8",
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /exact_review_queue_fact/);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.queueAccepted, 5);
  assert.equal(summary.executorDispatches, 2);
  assert.equal(summary.stillPending, 1);
  assert.equal(summary.terminalBeforeDispatch, 2);
  assert.equal(summary.driftRows, 15);
  assert.deepEqual(summary.selected, [43367, 128515, 119583, 121477, 77508]);
});
