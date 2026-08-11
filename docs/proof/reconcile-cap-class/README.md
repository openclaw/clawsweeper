# Recovery-cap skip-class proof

## Claim

The parked and standard dead-letter reconciliation summaries now distinguish open targets skipped
by the recovery ceiling as `recovery_cap`. When either path sees non-idle queue pressure and folds a
recoverable target into `skipped_targets`, it reports `recovery_deferred_pressure`. Existing
inspection failures retain their HTTP and timeout classes.

## Part 2 feasibility

Stopped as required: no cheap complete dispatch-to-claim transition source exists. Queue items keep
`claimedAt` only while they remain leased, so completed claims disappear from the active state.
Existing durable flow buckets count enqueue, completion, retry, and shed events; they do not count
claims, and there are no dispatching-phase entry or exit counters. Counting only active leased items
would undercount fast completions and could label a draining surge as zero progress. A correct
`claims_last_10m` would therefore require new claim-path bookkeeping, which this work order forbids.

`oldest_dispatching_key` already exists as
`handoff_health.phases.dispatching.oldest_key`. No queue, status-logic, dashboard, or Bay code changed.

## Red/green proof

On Node 24.19.0, the focused operator command was run before and after the implementation:

```text
node --test test/exact-review-dead-letter-operator.test.ts
```

The red run executed 59 tests: 56 passed and the three new assertions failed because parked
`recovery_cap`, standard `recovery_cap`, and standard `recovery_deferred_pressure` were absent. The
green run passed all 59 tests. The pre-existing bounded HTTP fixture remained green with
`http_403: 1` and `timeout: 3`. Machine-readable counts are in `test-evidence.json`.

## Read-only production replay

The immutable `parked-reviews.json` from scheduled run
https://github.com/openclaw/clawsweeper/actions/runs/31449984643, artifact `9085971968`, was replayed
against the current operator. Its SHA-256 is
`1187c6042803b5ba98048d64157cb98a5399c1cbde76b69ce25f18dffe23b88f`.

The replay used live GitHub target reads with the authenticated `gh` identity, a signed loopback
inventory route, idle loopback pressure, and no mutation route. It omitted `--execute` and emitted:

```json
{"action":"reconcile-parked","dry_run":true,"inventory_complete":true,"queue_pressure":"idle","inspected_targets":20,"terminal_targets":1,"repository_gone_targets":0,"resolved_targets":1,"open_targets":19,"recovered_targets":5,"skipped_targets":14,"skip_reasons":{"recovery_cap":14},"skip_samples":[]}
```

The exact output and provenance are in `production-replay-summary.json` and
`production-replay-provenance.json`. `run-production-replay.mjs` reproduces the read-only replay
while the artifact remains available.

## Gates

- `pnpm run build:all`: passed
- `pnpm run test:no-build`: 3,318 tests; 3,309 passed, 9 skipped, 0 failed
- `pnpm run lint`: passed
- `pnpm run format:check`: passed
- `pnpm run check:dashboard-queue-boundary`: passed
- `pnpm run check:active-surface`: passed

## Limits and Bay impact

The production proof exercises parked reconciliation; standard reconciliation classification is
covered by the red/green fixture. It does not mutate the queue or add handoff telemetry.

OpenClaw Bay is unaffected. Bay may continue to render the existing handoff status, but this
operator-only additive classification creates no status actions and Bay must not gain queue,
workflow, GitHub, DLQ, recovery, deploy, or rollback controls.
