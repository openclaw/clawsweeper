# Single-census queue read-model proof

## Claim

The exact-review queue read model builds one census of durable queue items per
request and preserves the normalized response bytes from the pre-refactor
merge-base for both `/api/exact-review-queue` and `/api/status`.

## Exercised surface

`run-proof.mjs` archives the merge-base and starts its real local Wrangler
Worker beside the candidate Worker. Independent SQLite-backed Durable Object
stores receive the same fixed-seed populations through the signed enqueue
route. The two public API responses are normalized only for volatile time,
request, and lease fields, then compared with insertion order intact.

The same proof instruments array traversals in the merge-base and candidate
read-model modules over a 1,200-item synthetic state. Instrumentation exists
only in the proof process: production code has no counters or timing hooks.

## Run

From a clean committed checkout on Node 24 or newer:

```bash
docs/proof/single-census-read-model/run-proof.sh
```

Artifacts are written below the ignored
`.artifacts/single-census-read-model/` directory. The receipt is `COMMITTED`
only when `HEAD` is a real commit and tracked files are clean before the run.

## Expected observation

- all fixed-seed populations return byte-identical normalized responses for
  both routes;
- the candidate records one full census traversal and one `Object.values`
  materialization for `/stats` plus its customized Bay projection;
- the merge-base performs multiple full or partial queue passes and repeats
  `Object.values` materialization;
- the proof exits zero and writes `proof-summary.json` with the exact counts,
  response hashes, merge-base, candidate head, and `COMMITTED` receipt.

## OpenClaw Bay and limits

OpenClaw Bay is unaffected. Its public projection is byte-identical and remains
observer-only; this change adds no queue, workflow, recovery, deploy, or
rollback action.

The Worker scenario uses synthetic pending reviews and a deterministic loopback
GitHub error stub. It does not contact GitHub, acquire review leases, publish
records, or mutate production. Randomized leased, parked, publication, Bay,
capacity, and next-wake combinations are covered by the separate fixed-seed
property-equivalence unit test.
