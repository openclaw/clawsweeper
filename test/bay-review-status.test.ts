import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { bayHtml } from "../dashboard/bay-page.ts";
import { reviewFailureExplanation } from "../src/review-failure-explanation.ts";

function harness() {
  const html = bayHtml();
  const script = html.split("<script>")[1]!.split("</script>")[0]!;
  const validator = script.slice(
    script.indexOf("  var MAX_BAY_COUNT="),
    script.indexOf("  function hash("),
  );
  const names = [
    "expandQueue",
    "activeAge",
    "itemHtml",
    "publicReferenceSource",
    "drawerItem",
    "openDrawer",
    "openQueueSampleDrawer",
  ];
  const source = names
    .map((name) => {
      const line = script.split("\n").find((line) => line.startsWith("  function " + name + "("));
      assert.ok(line, name);
      return line;
    })
    .join("\n");
  const state = { items: [] as any[], includeLegacyBatch: false, found: null };
  const nodes = new Map<string, any>();
  const node = (id: string) => {
    if (!nodes.has(id))
      nodes.set(id, {
        innerHTML: "",
        textContent: "",
        open: true,
        dataset: {},
        scrollTop: 17,
        contains: () => false,
      });
    return nodes.get(id);
  };
  const helpers = runInNewContext(
    validator +
      "\n" +
      source +
      ";({strictBayReference,strictBayReviewFailure,bayReviewStatus,expandQueue,activeAge,itemHtml,openDrawer,openQueueSampleDrawer,publicBayStatus})",
    {
      state,
      Date,
      STAGES: ["arriving", "setting-up", "reviewing", "publishing", "applying", "repairing"],
      LABELS: { repairing: "Repair & attention", reviewing: "Reviewing", failed: "Failed" },
      BAY_AREAS: ["repairing"],
      document: { getElementById: node },
      history: { replaceState() {} },
      esc: (value: unknown) =>
        String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"),
      hash: () => 1,
      bayCardPosition: () => ({ x: 0, y: 0 }),
      creatureArt: () => "",
      areaRows: () => state.items,
      drawnLimit: () => 1,
      areaLabel: () => "Repair & attention",
      areaCountCopy: () => "sampled",
    },
  );
  function rows(values: any[]) {
    const references = values.map((value) => helpers.strictBayReference(value, false));
    assert.ok(references.every(Boolean));
    state.items = helpers.expandQueue({
      exact_review_queue: { bay_projection: { activity: { complete: true, items: references } } },
    });
    return state.items;
  }
  return { html, helpers, state, node, rows };
}
const base = {
  repository: "openclaw/openclaw",
  item_number: 120887,
  source: "queue",
  stage: "repairing",
  queue_disposition: "parked_exhausted",
};

test("Bay shows the four legacy stopped reviews without inventing a historical cause", () => {
  const { helpers, node, rows, html } = harness();
  assert.match(html, /Repair & attention/);
  assert.doesNotMatch(html, /Repair cove/);
  const items = rows(
    [120887, 131455, 131604, 131464].map((item_number) => ({ ...base, item_number })),
  );
  for (const item of items) {
    const status = helpers.bayReviewStatus(item);
    assert.equal(status.type, "Stopped review");
    assert.match(status.status, /Retries exhausted.*operator attention/);
    assert.match(status.explanation, /Detailed historical reason unavailable/);
    assert.doesNotMatch(status.explanation, /ancestry|incompatible|fetch/i);
    assert.equal(helpers.activeAge(item).label, "Review stopped");
    helpers.openDrawer(item.id);
    assert.match(node("drawer-body").innerHTML, /Stopped review/);
    assert.match(node("drawer-body").innerHTML, /Detailed historical reason unavailable/);
    const card = helpers.itemHtml(item, 0, { short: "openclaw", color: "#000" }, 4, {
      name: "packed",
      compact: true,
      cardWidth: 44,
      cardHeight: 44,
    });
    assert.match(card, /Review stopped/);
    assert.match(card, /operator attention/);
  }
  helpers.openQueueSampleDrawer("repairing");
  assert.match(node("queue-sample-body").innerHTML, /Stopped review · Retries exhausted/);
  assert.match(node("queue-sample-body").innerHTML, /not drawn/);
  assert.equal(node("queue-sample-body").scrollTop, 17);
});

test("Bay renders only shared safe failure explanations, never raw diagnostic strings", () => {
  const { helpers, rows, node } = harness();
  for (const failure of [
    { stage: "source_preparation", reason: "source_incompatible" },
    { stage: "source_preparation", reason: "review_commit_fetch_failed" },
    { stage: "agent_input_scan", reason: "incomplete_source" },
    { stage: "provider_or_model", reason: "timeout" },
    { stage: "workflow", reason: "unknown" },
  ]) {
    const [item] = rows([{ ...base, review_failure: failure }]);
    const explanation = reviewFailureExplanation(failure);
    assert.ok(explanation);
    assert.equal(
      helpers.bayReviewStatus(item).explanation,
      "Last recorded review failure: " + explanation,
    );
    if (failure.reason === "incomplete_source")
      assert.doesNotMatch(explanation, /ancestry|incompatible/i);
    helpers.openDrawer(item.id);
    assert.match(node("drawer-body").innerHTML, /Last recorded review failure:/);
  }
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
    const reference = helpers.strictBayReference({ ...base, review_failure }, false);
    assert.equal(reference.review_failure, undefined);
    const [item] = rows([{ ...base, review_failure }]);
    helpers.openDrawer(item.id);
    assert.match(node("drawer-body").innerHTML, /Detailed historical reason unavailable/);
    assert.doesNotMatch(node("drawer-body").innerHTML, /private diagnostic|onerror|private\/repo/);
  }
});

test("scheduled retries, queued attention and live workflows stay distinct from stopped reviews", () => {
  const { helpers, rows, node } = harness();
  const action = {
    repository: "openclaw/clawsweeper",
    run_id: 123,
    status: "in_progress",
    started_at: new Date(Date.now() - 60000).toISOString(),
    steps_complete: true,
    steps: [{ sequence: 1, kind: "test", status: "in_progress", conclusion: null }],
  };
  const [scheduled, queued, live] = rows([
    { ...base, queue_disposition: "retry_scheduled" },
    { ...base, item_number: 2, queue_disposition: undefined },
    {
      ...base,
      item_number: 3,
      source: "live",
      action,
      review_failure: { stage: "workflow", reason: "workflow_failed" },
    },
  ]);
  assert.equal(helpers.bayReviewStatus(scheduled).type, "Queued retry");
  assert.equal(helpers.activeAge(scheduled).label, "Retry scheduled");
  assert.equal(helpers.bayReviewStatus(queued).type, "Queue attention");
  assert.equal(helpers.activeAge(queued).label, "Work queued");
  assert.equal(live.review_failure, undefined);
  assert.equal(live.queue_disposition, null);
  assert.equal(helpers.bayReviewStatus(live).type, "Live workflow");
  assert.equal(helpers.bayReviewStatus(live).status, "Running");
  helpers.openDrawer(live.id);
  assert.doesNotMatch(
    node("drawer-body").innerHTML,
    /Stopped review|historical reason|Last recorded|active code repair/,
  );
  assert.match(node("drawer-body").innerHTML, /Running/);
  assert.equal(
    helpers.strictBayReference(
      {
        ...base,
        journey_duration_ms: 1,
        review_failure: { stage: "workflow", reason: "workflow_failed" },
      },
      true,
    ).review_failure,
    undefined,
  );
  assert.equal(helpers.bayReviewStatus({ ...base, outcome: "failure" }), null);
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
});

test("parked publication or unclassified queue work is not called a stopped review", () => {
  const { helpers, rows, state, node } = harness();
  state.includeLegacyBatch = true;
  const [parked] = rows([{ ...base, queue_disposition: "parked", legacy_batch_path: true }]);
  const status = helpers.bayReviewStatus(parked);
  assert.equal(status.type, "Stopped queue work");
  assert.equal(helpers.activeAge(parked).label, "Work stopped");
  assert.doesNotMatch(status.explanation, /stopped review|historical reason/);
  helpers.openDrawer(parked.id);
  assert.doesNotMatch(node("drawer-body").innerHTML, /Review failure|Stopped review/);
});
