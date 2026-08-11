# Bounded StatusStore reads proof

## Claim

The public automerge-metrics and apply-observability responses are unchanged while the dashboard's
`StatusStore` Durable Object no longer reads and reprocesses the full retained event population on
every poll.

Automerge reads use the timestamp embedded in the durable key as the storage range, consume the
result in storage order, and return only the completed summary across the Durable Object boundary.
Apply observations are stored in UTC day+repository buckets; reads fetch only overlapping buckets
plus compatible legacy rows and also return only the summary.

## Transition strategy

Apply writes switch directly to day+repository buckets at deploy time. Reads merge those buckets
with the existing per-run legacy keys, deduplicate by repository/run/attempt, and prefer the newest
observation. Legacy rows already have a seven-day TTL, so they disappear without a migration,
backfill, destructive rewrite, or flag day. After that natural drain, only the range's handful of
day buckets are returned from storage.

## Exercised surface

- Real `wrangler dev --local` Worker and SQLite-backed `StatusStore` Durable Object for merge-base
  and candidate.
- Real `/api/events` automerge ingestion and signed `/internal/apply-observability` ingestion.
- Public 6h, 24h, and 7d queries, both unfiltered and repository-filtered; automerge also exercises
  policy filtering.
- A proof-only counting storage adapter around each revision's actual `StatusStore` class. It counts
  rows returned by `list()` and `get()` without changing production code.
- A replayed apply observation exactly at a UTC day boundary.

## Run

From the repository root on Node 24 or newer:

```bash
docs/proof/bounded-status-store-reads/run-proof.sh
```

The harness enables Corepack, installs the locked dependencies, extracts merge-base into a
disposable directory, starts both Wrangler runtimes on loopback, seeds 300 automerge events and 170
apply observations through production routes, and compares 12 normalized responses. Only
request-time-derived fields are normalized: `generated_at`, `range_start`, and automerge bucket
`start`/`end` timestamps.

## Local result

The controlled run completed with all 12 normalized responses byte-identical. Storage-row reads
were:

| Endpoint | Range | Before | After |
| --- | ---: | ---: | ---: |
| automerge-metrics | 6h | 2,120 | 120 |
| automerge-metrics | 24h | 2,120 | 216 |
| automerge-metrics | 7d | 2,120 | 1,080 |
| apply-observability | 6h | 169 | 2 |
| apply-observability | 24h | 169 | 4 |
| apply-observability | 7d | 169 | 16 |

See [`artifacts/local-summary.json`](artifacts/local-summary.json),
[`artifacts/row-counts.json`](artifacts/row-counts.json), and the per-query hashes and normalized
payloads in [`artifacts/response-comparison.json`](artifacts/response-comparison.json).

## OpenClaw Bay impact

None. The same observer responses retain the same fields and values; no Bay projection, lifecycle,
control, queue action, or public observer boundary changes.

## Limits

The population is synthetic local data, not production volume or a CPU benchmark. Row counts show
storage records returned to the implementation, not serialized bytes. During transition, live
legacy apply rows are still read and merged until their existing seven-day TTL expires. The proof
performs no production deployment, GitHub write, workflow dispatch, queue mutation, or Bay action.
