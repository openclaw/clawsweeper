# PR 674 observation-layer rollout

This observation layer must land before
[ClawSweeper PR 674](https://github.com/openclaw/clawsweeper/pull/674). It does not copy that
PR's per-item shard implementation or generation-bound queue protocol. Instead it provides the
backward-compatible contract that the later PR can populate.

## Health policy

The dashboard hero is green (`All clear`) only when every known signal is healthy. The aggregate
uses these stable rules:

| Signal                   | Green                      | Amber                       | Red                                                          |
| ------------------------ | -------------------------- | --------------------------- | ------------------------------------------------------------ |
| Publication health       | `idle` or `healthy`        | `degraded`                  | `critical`                                                   |
| Publication DLQ          | no open entries            | one or more open entries    | publication health is `critical`                             |
| Queue telemetry          | current snapshot available | unavailable or incomplete   | n/a                                                          |
| Durable review status    | refreshing under 30m       | refreshing for at least 30m | refreshing for at least 150m without a provably active lease |
| Queue/workflow execution | healthy or idle            | degraded/unknown            | stalled                                                      |

Open DLQ is amber even when another compatibility producer has not populated publication health.
`critical` and `stalled` always dominate and render the top-level indicator red.

## Durable review telemetry contract

Authenticated producers write one row per `(repo, item_number, run_id, run_attempt)` through
`POST /internal/exact-review/review-telemetry`. Operators and dashboards query an item's newest
attempts through:

```text
GET /api/exact-review-queue/reviews?repo=openclaw/openclaw&item_number=123&limit=20
```

Every row carries `status`, terminal `outcome`, `started_at`, `updated_at`, optional lease expiry,
and bounded phase durations for `queue`, `claim`, `review`, `publication`, and `total`.
`generation` and `operation_id` are optional until PR 674 supplies authoritative values. Terminal
rows cannot be reopened by a delayed refreshing heartbeat. Completed rows are retained for 30
days; active refreshing rows are retained until a producer records a terminal result.

The watchdog is deliberately read-only. An aged refreshing row without an active lease appears in
`review_telemetry_health.orphans` and turns dashboard health red, but observation alone never
changes the outcome to `interrupted`. A producer may record `interrupted` only after it proves the
GitHub run is terminal and no current lease owns the attempt.

## Rollout and rollback

1. Deploy this change and verify `/api/status` includes `dashboard_health` and
   `exact_review_queue.review_telemetry_health` while existing review traffic remains unchanged.
2. Confirm healthy traffic remains green, then exercise fixture or staging records at the 30m and
   150m boundaries. Do not create synthetic records in the live queue.
3. Land PR 674 and have each item shard write `refreshing` after its authoritative claim, update
   phase durations at transitions, then write exactly one terminal outcome. Populate its generation
   and operation identity without changing this endpoint shape.
4. Compare each sampled row with its full GitHub Actions run URL and verify repo, item, run attempt,
   generation, terminal outcome, and total duration. Confirm a live lease keeps an old heartbeat out
   of the orphan list.
5. Verify publication backlog, open DLQ, queue read failure, one degraded sample, and one
   critical/stalled sample all reach the dashboard hero with the expected amber/red severity.

If PR 674 must roll back, stop its telemetry writes only; this additive table and query remain safe
for older producers. Do not pause the live sweep. Investigate an orphan from its repo/item/run tuple,
then record `interrupted` only with terminal-run and lease evidence.
