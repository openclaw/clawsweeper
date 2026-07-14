import assert from "node:assert/strict";
import test from "node:test";

import { readText } from "./helpers.ts";

test("proof workflow enables and publishes immutable mutation receipts", () => {
  const workflow = readText(".github/workflows/proof-nudges.yml");
  const setup = workflow.indexOf("- uses: ./.github/actions/setup-action-ledger");
  const run = workflow.indexOf("- name: Run proof nudges");
  const finalize = workflow.indexOf("- name: Finalize proof handling action ledger");
  const upload = workflow.indexOf("- name: Upload finalized proof handling action ledger");
  const publish = workflow.indexOf("- name: Publish immutable proof handling action ledger");

  assert.match(workflow, /permissions:\n  actions: read/);
  assert.ok(setup >= 0);
  assert.ok(setup < run);
  assert.ok(run < finalize);
  assert.ok(finalize < upload);
  assert.ok(upload < publish);
  assert.match(
    workflow.slice(finalize, publish),
    /PROOF_OUTCOME:[\s\S]*--interrupt-open-attempts --reason cancelled[\s\S]*--interrupt-open-attempts --reason workflow_failed[\s\S]*finalize-action-events/,
  );
  assert.match(
    workflow.slice(upload, publish),
    /uses: actions\/upload-artifact@v7[\s\S]*proof-handling-action-ledger-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}[\s\S]*CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT \}\}\/ledger/,
  );
  assert.match(
    workflow.slice(publish),
    /publish-action-events -- \\\n\s+--source-root "\$source_root" \\\n\s+--state-root "\$CLAWSWEEPER_STATE_DIR" \\\n\s+--expected-producer-job "\$GITHUB_JOB"/,
  );
  assert.match(workflow.slice(publish), /publish-action-event-paths/);
});
