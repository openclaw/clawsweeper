import assert from "node:assert/strict";
import test from "node:test";
import {
  issueCloseProofScenarios,
  runIssueCloseProof,
} from "../scripts/e2e/apply-issue-close-freshness.mjs";

for (const scenario of issueCloseProofScenarios)
  test(
    `actual apply CLI keeps late-locked issues open: ${scenario}`,
    { timeout: 75_000 },
    async (t) => {
      const results = await runIssueCloseProof({ scenario, signal: t.signal });
      assert.equal(results.length, 1);
      assert.equal(results[0].scenario, scenario);
    },
  );
