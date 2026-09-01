import assert from "node:assert/strict";
import test from "node:test";

import {
  localCheckoutAccessForDecision,
  localCheckoutAccessSourceForDecision,
  reviewStatusForDecision,
} from "../dist/clawsweeper-report-document.js";
import { effectiveReviewStatusForTest } from "../dist/clawsweeper.js";

test("review publication trusts runner-owned checkout access instead of review prose", () => {
  const decision = {
    localCheckoutAccess: "verified" as const,
    summary: "The reviewed error text says bwrap: loopback failed, but the patch is correct.",
  };

  assert.equal(localCheckoutAccessForDecision(decision), "verified");
  assert.equal(localCheckoutAccessSourceForDecision(decision), "runner_preflight_v1");
  assert.equal(reviewStatusForDecision(decision), "complete");
  assert.equal(
    effectiveReviewStatusForTest(
      `---\nreview_status: complete\nlocal_checkout_access: verified\nlocal_checkout_access_source: runner_preflight_v1\n---\n${decision.summary}`,
    ),
    "complete",
  );
});

test("review publication fails closed without verified runner inspection", () => {
  assert.equal(localCheckoutAccessForDecision({ localCheckoutAccess: "unverified" }), "unverified");
  assert.equal(
    localCheckoutAccessSourceForDecision({ localCheckoutAccess: "unverified" }),
    "runner_preflight_v1",
  );
  assert.equal(
    reviewStatusForDecision({
      localCheckoutAccess: "unverified",
      summary: "The model returned a normal-looking review.",
    }),
    "failed",
  );
  assert.equal(
    reviewStatusForDecision({ summary: "The model returned a normal-looking review." }),
    "failed",
  );
  assert.equal(localCheckoutAccessSourceForDecision({}), "unknown");
  assert.equal(
    effectiveReviewStatusForTest(
      "---\nreview_status: complete\nlocal_checkout_access: verified\n---\nLegacy report",
    ),
    "stale_local_checkout_unverified",
  );
});
