import assert from "node:assert/strict";
import test from "node:test";
import { publicReviewCoverageProjection } from "../dashboard/public-observability.ts";
import { liveCoverage } from "../dashboard-site/src/lib/live-coverage.ts";
import { reviewCoverageRecordState } from "../src/review-coverage.ts";
const now = Date.parse("2026-11-02T21:00:00Z");
const timestamp = new Date(now).toISOString();
function fixture() {
  const row = {
    repo: "public/repo",
    repo_slug: "public-repo",
    visibility: "public",
    coverage_status: "complete",
    census_status: "complete",
    count_status: "observed",
    counts_observed_at: timestamp,
    observation_scope: "eligible",
    open_records: 3,
    reviewable_records: 3,
    reviewed_recent: 1,
    stale: 0,
    failed: 0,
    expired: 0,
    unreviewed_records: 0,
    untracked_open: 2,
    pending: 2,
    excluded: 0,
    record_drift: 2,
    needs_refresh: [{ number: 2, kind: "issue", category: "untracked_open", reviewed_at: null }],
  };
  return {
    ok: true,
    cohort: "live-open-identities-v1",
    scan_status: "current",
    generated_at: timestamp,
    inventory_generated_at: timestamp,
    inventory_status: "current",
    coverage_status: "complete",
    window_days: 7,
    totals: {},
    fleets: [row],
  };
}
test("public live coverage is identity-cohort, partition checked, private-redacted and idempotent", () => {
  const source = fixture();
  source.fleets.push({
    ...source.fleets[0]!,
    repo: "private/secret",
    repo_slug: "private-secret",
    visibility: "unknown",
  });
  const projected = publicReviewCoverageProjection(source)!;
  assert.equal(projected.totals.coverage_percent, 33.3);
  assert.equal(projected.totals.open_records, 3);
  assert.doesNotMatch(JSON.stringify(projected), /private[/]secret/);
  assert.deepEqual(publicReviewCoverageProjection(projected), projected);
  source.fleets[0]!.reviewed_recent = 3;
  assert.equal(publicReviewCoverageProjection(source), null);
});
test("incomplete identities preserve witnessed Open counts but never invent category totals", () => {
  const source = fixture();
  source.fleets.push({
    ...source.fleets[0]!,
    repo: "public/partial",
    repo_slug: "public-partial",
    coverage_status: "unknown",
    census_status: "unknown",
  });
  const projected = publicReviewCoverageProjection(source)!;
  assert.equal(projected.totals.open_records, 6);
  assert.equal(projected.totals.reviewable_records, null);
  assert.equal(projected.totals.coverage_percent, null);
  const model = liveCoverage(projected, now);
  assert.equal(model.known, false);
  assert.equal(model.rows[0].open_records, 3);
  assert.equal(model.rows[1].open_records, 3);
  assert.equal(model.rows[1].reviewable_records, null);
  assert.deepEqual(publicReviewCoverageProjection(projected), projected);
});
test("complete live census survives missing canonical evidence without inventing review buckets", () => {
  const source = {
    ...fixture(),
    fleets: [
      {
        ...fixture().fleets[0]!,
        coverage_status: "unknown",
        reason: "canonical_evidence_unavailable",
      },
    ],
  };
  const projected = publicReviewCoverageProjection(source)!;
  assert.equal(projected.census_status, "complete");
  assert.equal(projected.coverage_status, "unknown");
  assert.equal(projected.totals.open_records, 3);
  assert.equal(projected.totals.reviewed_recent, null);
  const model = liveCoverage(projected, now);
  assert.equal(model.open_records, 3);
  assert.equal(model.reviewable_records, 3);
  assert.equal(model.percent, null);
  assert.equal(model.rows[0].open_records, 3);
  assert.equal(model.rows[0].percent, null);
});

test("all Coverage consumers reject missing, stale, future census and stale/future scan without corpus fallback", () => {
  const projected = publicReviewCoverageProjection(fixture())!;
  assert.equal(liveCoverage(projected, now).percent, 33.3);
  for (const replacement of [
    null,
    "invalid",
    new Date(now + 1).toISOString(),
    new Date(now - 13 * 3600000).toISOString(),
  ]) {
    const model = liveCoverage({ ...projected, inventory_generated_at: replacement }, now);
    assert.equal(model.percent, null);
    assert.equal(model.open_records, 3);
    assert.equal(model.rows[0].open_records, 3);
    assert.equal(model.reviewable_records, null);
    assert.deepEqual(model.refresh, []);
  }
  for (const replacement of [
    new Date(now + 1).toISOString(),
    new Date(now - 16 * 60000).toISOString(),
  ])
    assert.equal(
      liveCoverage({ ...projected, record_scan_observed_at: replacement }, now).percent,
      null,
    );
});
test("observed reopen invalidates review, generic automation timestamps do not", () => {
  const item = {
    number: 1,
    kind: "issue" as const,
    labels: [],
    updated_at: timestamp,
    reopened_at: timestamp,
  };
  const report = {
    kind: "issue",
    status: "complete",
    reviewedAt: new Date(now - 1000).toISOString(),
  };
  assert.equal(reviewCoverageRecordState(report, item, now, 7 * 86400000), "stale");
  assert.equal(
    reviewCoverageRecordState(report, { ...item, reopened_at: null }, now, 7 * 86400000),
    "reviewed_recent",
  );
  for (const reviewedAt of [undefined, "invalid", new Date(now + 1).toISOString()])
    assert.equal(
      reviewCoverageRecordState({ ...report, reviewedAt }, item, now, 7 * 86400000),
      "unreviewed_records",
    );
});
