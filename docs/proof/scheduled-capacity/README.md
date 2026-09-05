# Scheduled review capacity proof

Scheduled hot intake and normal backfill must share at most eight active review
owners. Organic and manually requested reviews may use the remaining global
capacity. Reducing a limit preserves running owners and queued records; backlog
dispatch resumes as owners complete. Pending backlog must not create a one-second
alarm loop while its capacity is full.

[`proof-scheduled-capacity.mjs`](../../../scripts/proof-scheduled-capacity.mjs)
bundles the baseline and candidate queue into real workerd SQLite Durable Objects.
It seeds eight mixed scheduled owners, two pending scheduled items and one organic
item, then drives the actual alarm, dispatch and completion handlers. The baseline
dispatches all three pending reviews; the candidate dispatches only the organic
review, then one scheduled review after an owner completes. A second scenario
starts above the new limit with twelve owners and verifies that all survive while
both pending scheduled items remain held.

Run through the repository's resolved Crabbox provider with pinned tooling outside
the checkout:

```sh
npm install --prefix /tmp/clawsweeper-concurrency-proof-tools --no-save --no-audit --no-fund wrangler@4.107.0
node scripts/proof-scheduled-capacity.mjs 0c05db6804c797e671d0c0a6c4e3c8a10d5993d5 /tmp/clawsweeper-concurrency-proof-tools .artifacts/scheduled-capacity
```

The receipt records Git revisions, dirty state, source hashes, runtime, numeric
dispatch traces, retained owners and the full-cap wake delay. GitHub is a native
loopback HTTP fixture with a synthetic RSA credential; workerd egress is restricted
to that fixture. This exercises the real queue lifecycle and persistence, but does
not call live inference, mutate GitHub or alter production queue state. Unit tests
cover lease ownership after superseding requests, manual admission and wake timing;
workflow checks cover the lower scan cadence.

OpenClaw Bay is affected only by two optional numeric fields on the existing
observer-only queue projection: `scheduled_feed.max_concurrent` and `.active`.
Existing consumers remain compatible; no UI or action control is added. Public
projection tests verify the counts and retain the existing privacy boundary.
