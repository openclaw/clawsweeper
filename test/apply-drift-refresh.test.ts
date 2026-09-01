import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("default apply drift refresh executes queue-only ingress with bounded selection and live guards", () => {
  const output = execFileSync(process.execPath, ["scripts/e2e/apply-drift-refresh.ts"], {
    encoding: "utf8",
  });
  const summary = JSON.parse(output);
  assert.equal(summary.queueAccepted, 5);
  assert.equal(summary.executorDispatches, 2);
  assert.equal(summary.stillPending, 1);
  assert.equal(summary.terminalBeforeDispatch, 2);
  assert.equal(summary.driftRows, 15);
  assert.deepEqual(summary.selected, [43367, 128515, 119583, 121477, 77508]);
});
