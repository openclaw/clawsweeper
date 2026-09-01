#!/usr/bin/env node

const origin = String(process.argv[2] || "").replace(/\/+$/, "");
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) {
  throw new Error("runtime proof requires a loopback Worker origin");
}

const [statusResponse, bayResponse] = await Promise.all([
  fetch(`${origin}/api/status`, { cache: "no-store" }),
  fetch(`${origin}/bay`, { cache: "no-store" }),
]);
if (!statusResponse.ok || !bayResponse.ok) {
  throw new Error(`runtime routes failed: status=${statusResponse.status} bay=${bayResponse.status}`);
}

const status = await statusResponse.json();
const bayHtml = await bayResponse.text();
const activity = status?.exact_review_queue?.bay_projection?.activity;
const items = Array.isArray(activity?.items) ? activity.items : [];
const direct = items.filter((item) => item?.legacy_batch_path === false);
const legacy = items.filter((item) => item?.legacy_batch_path === true);
const timingComparison = status?.bay?.timings?.including_legacy_batch;
const defaultToggle =
  /id="legacy-proof-toggle"[^>]*aria-pressed="false"/.test(bayHtml) &&
  /Include retired proof\/batch/.test(bayHtml);

if (
  status?.public_projection_complete !== true ||
  activity?.complete !== true ||
  direct.length === 0 ||
  legacy.length === 0 ||
  !timingComparison ||
  !defaultToggle
) {
  throw new Error(
    JSON.stringify({
      public_projection_complete: status?.public_projection_complete,
      activity_complete: activity?.complete,
      direct_items: direct.length,
      legacy_items: legacy.length,
      timing_comparison: Boolean(timingComparison),
      default_toggle: defaultToggle,
    }),
  );
}

console.log(
  JSON.stringify({
    runtime: "wrangler dev --local",
    durable_object: "SQLite-backed ExactReviewQueue",
    http_routes: ["/api/status", "/bay"],
    public_projection_complete: true,
    activity_complete: true,
    direct_items: direct.length,
    legacy_items: legacy.length,
    default_legacy_toggle: false,
    timing_comparison_available: true,
    production_mutation: false,
  }),
);
