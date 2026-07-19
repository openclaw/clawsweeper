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
| Review execution         | coverage at least 98%      | coverage 90–98% or anomaly  | coverage under 90% with 10 attempts or 20% anomaly rate      |

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
`generation` and `operation_id` are optional until PR 674 supplies authoritative values. The v2
shape also adds indexed `trigger_lane`, `trigger_origin`, terminal reason/time, outcome, operation
identity, and phase durations while continuing to accept v1 rows. Terminal rows cannot be reopened
by a delayed refreshing heartbeat. Completed rows are retained for 30 days; active refreshing rows
are retained until a producer or terminal observer records a result.

The four review lanes are `exact_event`, `hot_intake`, `normal_backfill`, and `recovery`. Origins
are `webhook`, `command`, `schedule`, `manual`, or `system`; producers preserve the raw source
event/action as optional diagnostic context. Generation replacement is
`superseded/generation_superseded` and is displayed without degrading health. An unexplained
GitHub cancellation is `cancelled/workflow_cancelled` and does degrade health. A failed attempt
followed by success for the same `operation_id` remains in the raw failure count but is no longer
unresolved.

The watchdog is deliberately read-only. An aged refreshing row without an active lease appears in
`review_telemetry_health.orphans` and turns dashboard health red, but observation alone never
changes the outcome to `interrupted`. A producer may record `interrupted` only after it proves the
GitHub run is terminal and no current lease owns the attempt.

## Review reliability API and card

The main dashboard loads:

```text
GET /api/review-observability?range=24h&repo=all
```

Accepted ranges are `6h`, `24h`, and `7d`; repository values are `all` or one `owner/repo` slug.
The bounded response includes terminal coverage, outcome totals, expected supersession,
unexpected cancellation, recovered/unresolved failures, phase p50/p95, four lane freshness rows,
and at most 20 anomalies with complete item and Actions URLs. The card sits after Work execution
and before Exact Review. `normal_backfill` has its own row so exact-event or hot-intake success
cannot conceal global review failure.

Coverage uses the observer's paginated GitHub job count as an independent denominator, so an
entirely missing item-producer record lowers coverage instead of disappearing from both sides of
the ratio. Observer reconciliation is bound to the exact run attempt, and operation recovery is
scoped by repository plus operation ID.

The prerequisite deployment sets `REVIEW_OBSERVABILITY_REQUIRED=0`, and the card displays
`Awaiting v2 producers` instead of green. PR 674 sets the flag to `1` and records
`REVIEW_OBSERVABILITY_REQUIRED_SINCE` at rollout; the first 30 minutes are warm-up. After warm-up:

- Green requires terminal coverage at least 98%, no slow/orphan/unexpected cancellation or
  unresolved failure, and periodic lanes within two cadences.
- Amber covers 90–98% coverage, any missing terminal record in a small sample, a periodic lane
  beyond two cadences, a refreshing item at 30 minutes, an unexpected terminal anomaly, or
  unavailable telemetry.
- Red covers under 90% coverage with at least 10 expected attempts, a periodic lane beyond three
  cadences, an orphan at 150 minutes without active lease, at least five terminal samples with a
  20% anomaly rate, or stalled workflow execution.

Recovery is neutral `disabled` until explicitly enabled. Exact event is on-demand and remains
`idle` when it has no traffic. Expected superseded records and their duration are always visible
but never affect health.

## Rollout and rollback

1. Deploy this change and verify `/api/status` includes `dashboard_health` and
   `exact_review_queue.review_telemetry_health` while existing review traffic remains unchanged.
2. Confirm healthy traffic remains green, then exercise fixture or staging records at the 30m and
   150m boundaries. Do not create synthetic records in the live queue.
3. Rebase PR 674 onto this prerequisite. Have both its exact-event and per-item matrix jobs write
   `refreshing` only after authoritative claim, update queue/claim/review/publication durations,
   and write exactly one terminal outcome. Populate generation, operation identity, lane/origin,
   and terminal reason without changing these endpoints. Telemetry write failures warn but do not
   fail review.
4. Compare each sampled row with its full GitHub Actions run URL and verify repo, item, run attempt,
   generation, terminal outcome, and total duration. Confirm a live lease keeps an old heartbeat out
   of the orphan list.
5. Verify publication backlog, open DLQ, queue read failure, one degraded sample, and one
   critical/stalled sample all reach the dashboard hero with the expected amber/red severity.
6. In proposal-only mode, trigger two generations for one item. Verify the older generation is
   expected superseded, a sibling succeeds, terminal coverage is 100%, and item/run/generation/
   operation identities map to GitHub. Wait for at least one hot-intake and normal-backfill cadence
   before removing PR 674's draft status.

If PR 674 must roll back, first set `REVIEW_OBSERVABILITY_REQUIRED=0`, then stop its producer
writes. Keep observer data and 30-day item history; the card returns to passive/legacy behavior.
Do not pause the live sweep. Investigate an orphan from its repo/item/run tuple, then record
`interrupted` only with terminal-run and lease evidence.
