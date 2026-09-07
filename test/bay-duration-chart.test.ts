import assert from "node:assert/strict";
import test from "node:test";
import { bayHtml } from "../dashboard/bay-page.ts";

const html = bayHtml();
const script = html.split("<script>")[1]!.split("</script>")[0]!;
const helpers = script.slice(
  script.indexOf("  function journeyClock"),
  script.indexOf("  function selectJourneyBucket"),
);
const chart = new Function(
  "history",
  "now",
  "esc",
  "fmt",
  helpers + ";return journeyTimingChart(history,now);",
);
const now = Date.parse("2026-09-07T18:12:32Z");
function render(
  points: Array<{ ended_at: string; median_ms: number; average_ms: number; samples: number }>,
  at = now,
) {
  return String(
    chart(
      { points },
      at,
      (value: unknown) => String(value),
      (value: number) => String(value),
    ),
  );
}
function point(time: string, median = 120000, average = 180000, samples = 3) {
  return { ended_at: "2026-09-07T" + time + "Z", median_ms: median, average_ms: average, samples };
}

test("duration chart spans the actual last hour, including missing and partial edge buckets", () => {
  const result = render([point("18:10:00"), point("18:15:00", 60000)]);
  assert.match(result, /data-window-start="2026-09-07T17:12:32.000Z"/);
  assert.match(result, /data-window-end="2026-09-07T18:12:32.000Z"/);
  assert.equal((result.match(/data-journey-bucket=/g) || []).length, 13);
  assert.ok(result.includes("18:10:00–18:12:32 UTC (partial bucket)"));
  assert.match(result, /Median duration · minutes/);
  assert.match(result, /median 2 min · mean 3 min · 3 samples/);
  assert.match(result, /No bucket data · median — · mean — · samples unavailable/);
  assert.equal((result.match(/class="dot"/g) || []).length, 2);
});

test("missing intervals break the line and never create zero observations", () => {
  const result = render([point("17:20:00"), point("18:10:00")]);
  const path = result.match(/<path class="line" d="([^"]*)"/)![1]!;
  assert.equal((path.match(/M/g) || []).length, 2);
  assert.doesNotMatch(path, /L/);
  assert.equal((result.match(/class="journey-bucket missing"/g) || []).length, 11);
  assert.equal((result.match(/class="dot"/g) || []).length, 2);
});

test("single, empty and zero-duration histories preserve the scale and bucket controls", () => {
  const empty = render([]);
  assert.equal((empty.match(/class="journey-bucket missing"/g) || []).length, 13);
  assert.doesNotMatch(empty, /class="dot"/);
  assert.match(empty, /d=""/);
  const zero = render([point("18:10:00", 0, 0, 1)]);
  assert.match(zero, /median 0 min · mean 0 min · 1 sample/);
  assert.match(zero, /cy="96.00"/);
  assert.doesNotMatch(zero, /NaN|Infinity/);
  assert.equal(
    (render([], Date.parse("2026-09-07T18:10:00Z")).match(/data-journey-bucket=/g) || []).length,
    12,
  );
});

test("missing snapshot time does not fall back to the browser clock", () => {
  assert.match(render([], Number.NaN), /Chart unavailable: snapshot time missing/);
  assert.doesNotMatch(render([], Number.NaN), /data-journey-bucket/);
  assert.match(html, /class="journey-summary" aria-live="polite" aria-atomic="true"/);
  assert.ok(script.includes("freshness:strictBayFreshness(source.freshness,source.generated_at)"));
  assert.ok(script.includes('snapshotAt=Date.parse(timings.window_ended_at||"")'));
});

test("every bucket has an equivalent large native interval choice", () => {
  const result = render([point("18:10:00")]);
  assert.equal((result.match(/<option value="[0-9]+"/g) || []).length, 13);
  assert.ok(result.includes("Choose interval (touch or keyboard)"));
  assert.match(html, /min-height:44px/);
  assert.ok(script.includes('event.target.id!=="journey-interval-select"'));
});

test("off-window points neither stretch the time axis nor inflate the minutes scale", () => {
  assert.equal(render([point("16:10:00", 9999999), point("18:20:00", 9999999)]), render([]));
});

test("historical inventory is collapsed below operational telemetry with unchanged independent loading", () => {
  assert.match(html, /<details class="telemetry" id="bay-lifecycle-details">/);
  assert.ok(html.indexOf('id="bay-lifecycle-details"') > html.indexOf('id="bay-system-details"'));
  assert.doesNotMatch(html, /Every review revision ClawSweeper has recorded/);
  assert.match(html, /All retained records.*latest recorded state/);
  assert.match(html, /Beach and time filters do not apply/);
  assert.match(html, /One target revision can have multiple lifecycle records/);
  assert.ok(html.includes('fetch("/api/durable-lifecycle-bay",{cache:"no-store"})'));
  assert.match(html, /id="legacy-proof-toggle" aria-pressed="false"/);
  assert.match(html, /Modern inline proof remains included/);
  assert.ok(script.includes("restoreJourneyBucket(node,focusedKey)"));
  new Function(script);
});
