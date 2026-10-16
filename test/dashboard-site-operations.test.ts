import assert from "node:assert/strict";
import test from "node:test";
import { summarizeOperations } from "../dashboard-site/scripts/operations.ts";
import {
  exactReviewHistorySample,
  normalizeHealthHistorySample,
} from "../dashboard/operational-health.ts";

const now = Date.parse("2026-10-14T08:00:00Z");

test("apply freshness and measured result coverage remain independent in Operations", () => {
  const value = {
    telemetry_complete: true,
    totals: { applied: null, closed: null },
    result_coverage: {
      totals: {
        completed_lifecycle_events: 4,
        fields: {
          applied: { measured_events: 3, missing_events: 1 },
          closed: { measured_events: 2, missing_events: 2 },
        },
      },
    },
  };
  const result = summarizeOperations({}, value, {}, now);
  assert.equal(result.apply.day.observationsCurrent, true);
  assert.equal(result.apply.day.applied, null);
  assert.deepEqual(result.apply.day.resultCoverage, { completed: 4, applied: 3, closed: 2 });
  assert.equal(result.apply.week.resultCoverage, null);
  assert.equal(result.apply.week.observationsCurrent, null);
});
function sample(
  minute: number,
  review: Record<string, number>,
  publication: Record<string, number>,
  handoff = true,
) {
  return {
    at: new Date(now - 3_600_000 + minute * 60_000).toISOString(),
    exact_review: {
      collection_ok: true,
      review: { pending: 3, ...review },
      publication: { pending: 2, ...publication },
      ...(handoff ? { handoff: { status: "healthy", leased: 1 } } : {}),
    },
  };
}
function hour(samples: unknown[]) {
  return summarizeOperations({ samples }, {}, {}, now).hours.at(-2)!;
}

test("publication history preserves actual deliveries separately from completions", () => {
  const value = exactReviewHistorySample({
    lanes: {
      review: { pending: 0 },
      publication: { pending: 1, completed_total: 100, published_total: 70 },
    },
  });
  assert.equal(value.publication?.published_total, 70);
  assert.deepEqual(
    normalizeHealthHistorySample({ at: new Date(now).toISOString(), exact_review: value })
      ?.exact_review,
    value,
  );
  const result = hour([
    sample(0, { completed_total: 10 }, { completed_total: 100, published_total: 70 }),
    sample(5, { completed_total: 15 }, { completed_total: 109, published_total: 72 }),
  ]);
  assert.equal(result.completed, 5);
  assert.equal(result.published, 2);
  assert.equal(result.enqueued, null);
  assert.equal(result.shed, null);
});

test("one missing or reset counter does not erase independent counter growth or queue depths", () => {
  const result = hour([
    sample(
      0,
      { completed_total: 10, enqueued_total: 100, shed_total: 4 },
      { published_total: 70 },
      false,
    ),
    sample(5, { completed_total: 15, enqueued_total: 2 }, { published_total: 71 }, false),
    sample(
      10,
      { completed_total: 17, enqueued_total: 3, shed_total: 6 },
      { published_total: 72 },
      false,
    ),
  ]);
  assert.equal(result.completed, 7);
  assert.equal(result.enqueued, 1);
  assert.equal(result.shed, null);
  assert.equal(result.published, 2);
  assert.equal(result.reviewPending, 3);
  assert.equal(result.publicationPending, 2);
  assert.equal(result.handoff, null);
  assert.equal(result.leased, null);
});

test("legacy publication counts, long gaps and future samples cannot invent deliveries", () => {
  const samples = [
    sample(0, { completed_total: 10 }, { completed_total: 100 }),
    sample(20, { completed_total: 20 }, { completed_total: 200 }),
  ];
  const result = hour([
    ...samples,
    sample(120, { completed_total: 200 }, { published_total: 100 }),
  ]);
  assert.equal(result.completed, null);
  assert.equal(result.published, null);
  assert.equal(result.reviewPending, 3);
  assert.equal(
    summarizeOperations({ samples: [sample(120, {}, {})] }, {}, {}, now).handoffSamples.observed,
    0,
  );
});

test("shed shares pair counter intervals before hourly reduction", () => {
  const reset = [
    sample(0, { enqueued_total: 100, shed_total: 4 }, {}),
    sample(5, { enqueued_total: 2, shed_total: 6 }, {}),
  ];
  const unmatched = summarizeOperations({ samples: reset }, {}, {}, now);
  assert.equal(unmatched.hours.at(-2)?.shed, 2);
  assert.equal(unmatched.reviewOffers, null);

  const mixed = summarizeOperations(
    { samples: [...reset, sample(10, { enqueued_total: 4, shed_total: 8 }, {})] },
    {},
    {},
    now,
  );
  assert.equal(mixed.hours.at(-2)?.shed, 4);
  assert.equal(mixed.hours.at(-2)?.enqueued, 2);
  assert.deepEqual(mixed.reviewOffers, { accepted: 2, shed: 2 });
});

test("paired offers distinguish measured zero, missing counters and the current hour", () => {
  const zero = [
    sample(0, { enqueued_total: 1, shed_total: 2 }, {}),
    sample(5, { enqueued_total: 1, shed_total: 2 }, {}),
  ];
  assert.deepEqual(summarizeOperations({ samples: zero }, {}, {}, now).reviewOffers, {
    accepted: 0,
    shed: 0,
  });
  assert.equal(
    summarizeOperations(
      { samples: [sample(0, { shed_total: 2 }, {}), sample(5, { shed_total: 3 }, {})] },
      {},
      {},
      now,
    ).reviewOffers,
    null,
  );
  assert.equal(
    summarizeOperations(
      {
        samples: [
          sample(60, { enqueued_total: 1, shed_total: 2 }, {}),
          sample(65, { enqueued_total: 2, shed_total: 3 }, {}),
        ],
      },
      {},
      {},
      now + 10 * 60_000,
    ).reviewOffers,
    null,
  );
});
