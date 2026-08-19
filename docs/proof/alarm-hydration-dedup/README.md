# Alarm hydration deduplication proof

## Claim

The real dashboard Worker and `ExactReviewQueue` Durable Object produce byte-identical normalized
public queue state for the same populated batch-publication alarm scenario, while two redundant
full item-table hydrations are removed from that alarm execution.

## Exercised surface

- Merge-base and candidate source trees, each installed and built independently on Node 24+
- Real `wrangler dev --local` Workers and SQLite-backed `ExactReviewQueue` Durable Objects
- Eight publication records seeded through the signed `/internal/exact-review/enqueue` route
- Automatic Durable Object alarms and a loopback GitHub App/API stub that accepts the real batch
  workflow dispatch
- Public `/api/exact-review-queue` snapshots immediately after seeding and after batch dispatch
- The existing test-only SQLite adapter around each revision's actual queue class, counting the
  full `SELECT item_key, item_json FROM exact_review_queue_items` hydration query

Only volatile clock-derived fields, request IDs, and UUIDs are normalized. The harness requires
the normalized merge-base and candidate JSON bytes to match both before and after the alarm.

## Eliminated reads

| Reused hydration | Why the second read cannot differ |
| --- | --- |
| Alarm housekeeping transaction snapshot | Between the legacy compatibility mirror and the former next-line read, the callback only returns and the synchronous transaction closes; neither path writes the normalized item table or dispatcher. |
| Post-terminal-preflight snapshot used for batch reservation | Between the recheck and reservation, the code performs only synchronous capacity, admission, candidate, and backoff calculations; there is no `await` or normalized-state mutation. |

Every later alarm read remains because an external await or a possible queue-state write intervenes.

## Run

From the repository root on Node 24 or newer:

```bash
docs/proof/alarm-hydration-dedup/run-proof.sh
```

Generated evidence is written under `docs/proof/alarm-hydration-dedup/artifacts/`, including exact
base/head provenance, raw and normalized queue snapshots, an empty normalized diff, Worker logs,
GitHub-stub requests, scan-count test logs, and `proof-summary.json`.

## Limits and OpenClaw Bay impact

The GitHub service is a loopback behavioral stub; no production repository, Worker, secret,
comment, workflow, or queue is contacted or mutated. SQL scan counts come from the existing
test-only storage adapter, because Wrangler does not expose per-query counts without production
instrumentation. This is state-equivalence and query-count proof, not a CPU benchmark.

OpenClaw Bay is unaffected. The change alters neither queue/lifecycle data nor any public observer
schema or control boundary.
