# Webhook retention census proof

- Status: historical controlled proof fixture
- Owner: ClawSweeper maintainers
- Source of truth: the adjacent runner and Worker fixture, the storage census and webhook retention owner
- Baseline: `openclaw/clawsweeper@ef5a507f43321fda5babbc176283756d9e755944`
- Update when: census pagination, classification, authentication or retention predicates change

Run from the repository root with the Wrangler 4.131.1 runtime dependencies
available in `PROOF_TOOL_ROOT`: Miniflare 5.20260911.0-alpha, esbuild 0.28.1 and
Workerd 1.20260911.1.

```sh
PROOF_TOOL_ROOT=/path/to/runtime-tools node docs/proof/webhook-retention-census/run-proof.mjs
```

The runner loads the two unchanged baseline owner modules from Git, exercises
the actual signed Worker/queue storage endpoint, then restarts the candidate
against the same SQLite Durable Object. It also runs the real census CLI over
local HTTP. Synthetic raw and compressed placeholders, tombstones, retired
payloads, stale protection, active families, future deadlines and due candidates
must reconcile with stored byte totals. The before/after SQL/KV digest and alarm
must remain unchanged. A cold object must reject missing schemas without
creating webhook state. Dense capped families exercise bounded indexed probes,
two-page completion and a capped continuation with its fixed time cutoff.

Results go to stdout, including the candidate bundle digest, runtime version,
category totals, native SQL rows read/written and elapsed time. Temporary
databases are removed on exit. Outbound requests are rejected and counted;
Cloudflare production, R2, deployments and real credentials are not used.
This fixture qualifies synthetic behavior and query bounds, not production
retention eligibility, reclaimable pages, CPU limits or throughput.
