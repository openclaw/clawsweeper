import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const runner = readFileSync("docs/proof/review-retry-fencing/run-proof.sh", "utf8");

test("retry-fencing proof defaults generated output to the artifact area", () => {
  assert.match(
    runner,
    /REVIEW_RETRY_FENCING_PROOF_OUTPUT:-\.artifacts\/review-retry-fencing\/result\.json/,
  );
  assert.doesNotMatch(
    runner,
    /REVIEW_RETRY_FENCING_PROOF_OUTPUT:-docs\/proof\/review-retry-fencing/,
  );
});
