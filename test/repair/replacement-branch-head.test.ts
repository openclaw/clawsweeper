import assert from "node:assert/strict";
import test from "node:test";
import { runReplacementBranchProof } from "../../docs/proof/replacement-branch-head/run-proof.mjs";

test("fresh replacement branches materialize fetched heads and retain checkout guards", () => {
  const result = runReplacementBranchProof();
  assert.equal(Object.keys(result.observations).length, 4);
});
