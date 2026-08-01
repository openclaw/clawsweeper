# CSW-092 controlled runtime proof

Code exercised: `ef3b016046258f4d4b98dc473cd269e1863c2028`.
This commit is the product-code parent of the evidence-only successor recorded
in the pull request body. No application source changed in that successor.

## Environment and command

```text
Crabbox lease: cbx_34f66acb8a77
Provider: local-container (Docker)
Image: mcr.microsoft.com/playwright:v1.60.0-noble
Command: crabbox run --provider local-container --local-container-image \
  mcr.microsoft.com/playwright:v1.60.0-noble --no-hydrate --timing-json \
  --script docs/proof/openclaw-bay/run-proof.sh
```

The controlled browser proof completed 48 assertions and wrote 23 frames. Its
fixture intercepted zero external GitHub API requests and made zero queue,
GitHub, or production mutations.

## Observations

- The real built Bay document rendered a populated **Recent durable events**
  card. The captured frame is
  [`01a-mini-control-board.jpg`](./01a-mini-control-board.jpg): the fixture's
  24-hour aggregate displayed direct `accepted 3`, `deduped 1`, and batch
  `retryable 2` counts.
- The Worker route test exercised `/api/recent-durable-publication-events` for
  the six-hour window, checked a complete result and public redaction, then
  repeated that request and observed only the first direct/batch source reads
  (the 60-second in-memory per-window cache served the repeat).
- The aggregate helper tests cover all allowed six-hour, 24-hour, and seven-day
  windows: every response has exactly 24 buckets; an empty complete window is
  idle; malformed, mixed, unavailable, and over-10,000-row sources produce
  `complete: false` and Unknown rather than partial counts.
- The Worker status test simulates an unavailable aggregate route while a real
  queue `/stats` response succeeds. `/api/status` retains
  `exact_review_queue.pending: 0`, returns HTTP success, and exposes only the
  aggregate as unavailable with `recent_durable_publication_events_error`.
  This demonstrates the optional aggregate cannot turn core queue status into
  a failure.
- The positive fixture and endpoint assertions contain no repository identity,
  receipt, fence, revision, or run identifier. Workflow-only activity remains
  outside the event schema and is never asserted or rendered as lifecycle
  completion.

## Limits

This is a controlled, synthetic fixture against the real built Worker/Bay
surfaces, not a production traffic measurement. A cold per-window request can
still issue the two indexed retained-event scans, each capped at 10,000 + 1;
at high source rates it intentionally reports Unknown instead of partial data.
The short-lived cache reduces repeat scans but is not a persistent rollup and
does not make availability or seven-day source-rate guarantees.
