# Bounded status-store reads behavior contract

## User-visible goal

The automerge-metrics and apply-observability APIs retain their existing JSON contracts while their
Durable Object reads scale with the requested time window rather than the full retained event set.

## Target

- Type: HTTP JSON API backed by a real local Wrangler Worker and Durable Object.
- Access: `/api/automerge-metrics` and `/api/apply-observability`.
- Fixtures: synthetic automerge events ingested through `/api/events` and synthetic apply
  observations ingested through the signed `/internal/apply-observability` route.
- Credentials: disposable proof-only bearer and HMAC values supplied to local Wrangler.

## User tasks

1. Query 6h, 24h, and 7d automerge metrics, with and without repository/policy filters.
2. Query 6h, 24h, and 7d apply observability, with and without a repository filter.
3. Retry apply observations at a UTC day boundary and observe one logical event.

## Expected observable behavior

- Merge-base and the candidate return byte-identical normalized JSON for every representative
  query; normalization covers only request-time-derived timestamps.
- Automerge ranges, buckets, percentiles, filters, outcomes, and session projections are unchanged.
- Apply event counts, repository health, queue/lease state, window totals, retry amplification, and
  failure fields are unchanged.
- Candidate automerge reads return only time-keyed rows inside the requested range.
- Candidate apply reads return only overlapping day+repository buckets plus still-live legacy rows.

## Anti-cheat probes

- Seed different repositories, policies, outcomes, latencies, queue values, and failure kinds.
- Query filtered and unfiltered variants at every supported range.
- Count storage rows returned to the merge-base and candidate `StatusStore` implementations with a
  proof-only storage adapter and a large out-of-range population.
- Replay a day-boundary apply observation and require one logical event.

## Evidence required

- Machine-readable response comparison with the exact normalized fields named.
- Machine-readable before/after storage-row counts for 6h, 24h, and 7d.
- Wrangler transcript proving both revisions used the real Worker and Durable Object routes.
- Source revisions, runtime versions, command, and limits.

## Out of scope

- Production deployment, production data, GitHub writes, workflow dispatch, and OpenClaw Bay.
- Performance claims about Durable Object CPU time or bytes beyond the observed row counts.
