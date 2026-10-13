import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { bayReviewStatusScript } from "../dashboard/bay-review-status.ts";
import { reviewFailureExplanation } from "../src/review-failure-explanation.ts";

const base = {
  repository: "openclaw/openclaw",
  item_number: 120887,
  source: "queue",
  stage: "repairing",
  queue_disposition: "parked_exhausted",
};

const reviewStatus = runInNewContext(bayReviewStatusScript + ";bayReviewStatus");

test("Overview labels stopped reviews without inventing a historical cause", () => {
  for (const item_number of [120887, 131455, 131604, 131464]) {
    const status = reviewStatus({ ...base, item_number });
    assert.equal(status.type, "Stopped review");
    assert.match(status.status, /Retries exhausted.*operator attention/);
    assert.match(status.explanation, /Detailed historical reason unavailable/);
    assert.doesNotMatch(status.explanation, /ancestry|incompatible|fetch/i);
  }
});

test("Overview uses shared safe review failure explanations", () => {
  for (const failure of [
    { stage: "source_preparation", reason: "source_incompatible" },
    { stage: "source_preparation", reason: "review_commit_fetch_failed" },
    { stage: "agent_input_scan", reason: "incomplete_source" },
    { stage: "provider_or_model", reason: "timeout" },
    { stage: "workflow", reason: "unknown" },
  ]) {
    const explanation = reviewFailureExplanation(failure);
    assert.ok(explanation);
    assert.equal(
      reviewStatus({ ...base, review_failure: failure }).explanation,
      "Last recorded review failure: " + explanation,
    );
    if (failure.reason === "incomplete_source")
      assert.doesNotMatch(explanation, /ancestry|incompatible/i);
  }
});

test("Overview distinguishes scheduled retries from queued attention", () => {
  assert.equal(
    reviewStatus({ ...base, queue_disposition: "retry_scheduled" }).type,
    "Queued retry",
  );
  assert.equal(reviewStatus({ ...base, queue_disposition: undefined }).type, "Queue attention");
  assert.equal(reviewStatus({ ...base, outcome: "failure" }), null);
});

test("Overview does not call parked publication work a stopped review", () => {
  const status = reviewStatus({ ...base, queue_disposition: "parked", legacy_batch_path: true });
  assert.equal(status.type, "Stopped queue work");
  assert.doesNotMatch(status.explanation, /stopped review|historical reason/);
});

test("dashboard public Bay sample preserves safe review status and drops live diagnostics", async () => {
  const { dashboardHtml } = await import("../dashboard/dashboard-pages.ts");
  const script = dashboardHtml()
    .split("<script>")
    .find((part) => part.includes("BAY_REVIEW_FAILURE_EXPLANATIONS"))!
    .split("</script>")[0]!;
  const start = script.indexOf("  var BAY_REVIEW_FAILURE_EXPLANATIONS=");
  const end = script.indexOf("function dashboardStatusSnapshot", start);
  assert.ok(start >= 0 && end > start);
  const helper = runInNewContext(
    script.slice(start, end) + ";({dashboardPublicBayReferences,bayReviewStatus})",
  );
  const [stopped, live] = helper.dashboardPublicBayReferences([
    { ...base, review_failure: { stage: "source_preparation", reason: "source_incompatible" } },
    {
      ...base,
      item_number: 3,
      source: "live",
      review_failure: { stage: "workflow", reason: "workflow_failed" },
    },
  ]);
  assert.equal(stopped.review_failure.reason, "source_incompatible");
  assert.equal(helper.bayReviewStatus(stopped).type, "Stopped review");
  assert.equal(live.review_failure, undefined);
  assert.equal(live.queue_disposition, undefined);
  assert.equal(helper.bayReviewStatus(live).type, "Live workflow");
  for (const review_failure of [
    null,
    [],
    "private diagnostic",
    { stage: "workflow" },
    { stage: "workflow", reason: 42 },
    { stage: "workflow", reason: "<img src=x onerror=alert(1)>" },
    { stage: "private/repo", reason: "workflow_failed" },
    { stage: "__proto__", reason: "toString" },
    { stage: "workflow", reason: "workflow_failed", raw_detail: "private diagnostic" },
  ]) {
    const [item] = helper.dashboardPublicBayReferences([{ ...base, review_failure }]);
    assert.equal(item.review_failure, undefined);
    assert.match(
      helper.bayReviewStatus(item).explanation,
      /Detailed historical reason unavailable/,
    );
    assert.doesNotMatch(JSON.stringify(item), /private diagnostic|onerror|private\/repo/);
  }
  for (const queue_disposition of ["parked_exhausted", "parked", "retry_scheduled"]) {
    const [item] = helper.dashboardPublicBayReferences([{ ...base, queue_disposition }]);
    assert.equal(item.queue_disposition, queue_disposition);
  }
  for (const queue_disposition of ["__proto__", "private-debug-value", 42, null]) {
    const [item] = helper.dashboardPublicBayReferences([{ ...base, queue_disposition }]);
    assert.equal(item.queue_disposition, undefined);
  }
});
