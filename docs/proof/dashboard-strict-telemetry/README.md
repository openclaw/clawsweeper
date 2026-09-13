# Dashboard strict telemetry proof

Status: active validation recipe. Owner: dashboard types and failure telemetry.
Source: the strict configuration and checker, failure telemetry, source revision
material, and durable-storage helper. Update when those contracts change.

This bounded slice adds three roots to the existing strict ratchet. The sole
production annotation records the complete closed stage map constructed from
the same constant used by its index validator; it changes no runtime logic.

```sh
node scripts/check-dashboard-strict.mjs
node --test test/check-dashboard-strict.test.ts
node docs/proof/dashboard-strict-telemetry/run-proof.mjs 49446cd30622e642efceb80e1c0347b2602a0117
```

Node 24+ runs the actual baseline and candidate modules against separate
on-disk SQLite databases. Four stage categories, duplicate insertion, and a
new store instance exercise persistence and aggregation. The storage helper
inspects the real table, and the source boundary accepts a valid synthetic
item and rejects malformed input. Baseline and candidate results must match.
The receipt records source hashes and runtime under `.artifacts/`.

No Worker deployment or production state is touched. Bay's existing telemetry
contract and observer-only behavior remain unchanged. The queue and Worker
monoliths and the broader public-observability module remain outside this slice.
