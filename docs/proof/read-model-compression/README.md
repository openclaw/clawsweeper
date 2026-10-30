# Read-model compression proof

Run from the repository root with pinned Miniflare, esbuild and Workerd available
through `PROOF_TOOL_ROOT` (a directory containing `package.json`):

```sh
PROOF_TOOL_ROOT=/path/to/runtime-tools node docs/proof/read-model-compression/run-proof.mjs
```

The local-only fixture archives frozen baseline
`d44a78ce5f214999b5cce854613319f9453989b9`, seeds its actual queue/SQLite owners,
then restarts the candidate against the same named Durable Object and files.
`PROOF_BASELINE_ARCHIVE` can supply that exact `git archive` when the remote
checkout has no Git objects. The runner reports its digest. No Cloudflare calls,
deployments, R2 objects or Node compatibility flag are used. Temporary source
and databases are removed on exit; results go to stdout.

Assertions cover five-table exact decoded bytes and metadata, large marker-bearing
comments, Unicode and historical fields, raw-before-activation behavior, bounded
passes, migration and completed-checkpoint restart, ordinary reads and digests,
placeholder retention, terminal facts and acknowledgement after conversion.
The result separately reports stored field bytes, decoded bytes, occupied SQLite
pages, native rows read, and wall time including fixture overhead. This synthetic
workload does not qualify production CPU, memory or throughput. Node tests cover
corruption, byte caps, concurrent CAS changes, rollback and signed operator calls.
