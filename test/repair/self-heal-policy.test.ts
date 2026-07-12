import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { shouldSelfHealRunRecord } from "../../dist/repair/self-heal-policy.js";

test("self-heal selects retryable post-flight reports even from legacy green runs", () => {
  assert.equal(
    shouldSelfHealRunRecord({
      workflow_conclusion: "success",
      post_flight_outcome: "requeue",
    }),
    true,
  );
  assert.equal(
    shouldSelfHealRunRecord({
      workflow_conclusion: "failure",
      post_flight_outcome: "blocked",
    }),
    false,
  );
  assert.equal(shouldSelfHealRunRecord({ workflow_conclusion: "failure" }), true);
  assert.equal(shouldSelfHealRunRecord({ workflow_conclusion: "success" }), false);
});

test("published run records preserve post-flight retry state for self-heal", () => {
  const publisher = fs.readFileSync("src/repair/publish-result.ts", "utf8");
  const selfHeal = fs.readFileSync("src/repair/self-heal-failed-runs.ts", "utf8");
  assert.match(publisher, /post_flight_outcome: postFlightReport\.outcome \?\? null/);
  assert.match(publisher, /post_flight_detail: postFlightReport\.detail \?\? null/);
  assert.match(selfHeal, /\.filter\(\(record: JsonValue\) => shouldSelfHealRunRecord\(record\)\)/);
});
