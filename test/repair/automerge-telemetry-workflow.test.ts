import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/repair-cluster-worker.yml", "utf8");

test("repair workflow reports failed automerge sessions without changing control flow", () => {
  const step = workflow
    .split("- name: Reconcile failed automerge telemetry")[1]
    ?.split("\n      - name: ")[0];

  assert.ok(step, "expected failed automerge telemetry step");
  assert.match(step, /always\(\) && failure\(\)/);
  assert.match(step, /inputs\.automerge_session_id != ''/);
  assert.match(step, /steps\.requeue_dispatch\.outcome != 'success'/);
  assert.match(step, /continue-on-error: true/);
  assert.match(step, /dashboard-reconcile-automerge\.ts/);
  assert.match(step, /--session-id/);
  assert.match(step, /--run-url/);
  assert.match(step, /--run-conclusion failure/);
  assert.match(step, /AUTOMERGE_SESSION_ID: \$\{\{ inputs\.automerge_session_id \}\}/);
  assert.match(step, /--session-id "\$AUTOMERGE_SESSION_ID"/);
  assert.doesNotMatch(step, /--session-id "\$\{\{/);
});
