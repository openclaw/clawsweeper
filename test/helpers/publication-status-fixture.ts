export function publicationEventsFixture(now = Date.now(), complete = [true, true], idle = false) {
  const capturedAt = new Date(now).toISOString();
  const source = (outcomes: string[], known: boolean) => ({
    complete: known,
    rows: known ? (idle ? 0 : 1) : null,
    latest_observed_at: known && !idle ? capturedAt : null,
    counts: Object.fromEntries(
      outcomes.map((outcome, index) => [outcome, known ? Number(!idle && index === 0) : null]),
    ),
    buckets: Array.from({ length: 24 }, (_, index) => ({
      index,
      counts: Object.fromEntries(
        outcomes.map((outcome, position) => [
          outcome,
          known ? Number(!idle && index === 23 && position === 0) : null,
        ]),
      ),
    })),
  });
  return {
    version: 1,
    captured_at: capturedAt,
    window: {
      id: "24h",
      start_at: new Date(now - 86_400_000).toISOString(),
      end_at: capturedAt,
      bucket_seconds: 3_600,
      bucket_count: 24,
    },
    collection: {
      state: complete.every(Boolean) ? "complete" : complete.some(Boolean) ? "mixed" : "unknown",
      complete: complete.every(Boolean),
      scan_limit: 10_000,
    },
    activity: { state: complete.every(Boolean) ? (idle ? "idle" : "observed") : "unknown" },
    direct: source(["accepted", "deduped", "superseded", "fallback"], complete[0]!),
    batch: source(["retryable", "superseded", "permanent"], complete[1]!),
  };
}

export function publicationStatusFixture(events = publicationEventsFixture()) {
  return {
    schema_version: 1,
    generated_at: events.captured_at,
    fleet: {},
    workers: [],
    automatic_work: [],
    pipeline: [],
    bay: {
      timings: {
        sample_kind: "completed_review_journeys",
        source: "durable_exact_review_lifecycles",
        completion_source: "verified_final_review_receipts",
        including_legacy_batch: { overall: {}, history: {} },
      },
    },
    recent: {},
    diagnostics: { errors: [], error_count: 0 },
    recent_durable_publication_events: events,
  };
}
