# Claim-time review budget charging proof

Status: proof for charging the exact-review budget when a workflow run claims a
review lease. The owning code is `chargeClaimedReviewExecutionSync` and the
`/claim` route in `dashboard/exact-review-queue.ts`; the contract is described
in [Automation limits](../../limits.md) and [Scheduler](../../scheduler.md).
The earlier admission-time accounting proof is
[historical](../scheduled-budget/README.md).

## Contract

- Claim: the global review budget meters executed reviews. Every new claim
  generation of a review lease debits one token; organic admission,
  superseding revisions, coalesces, dedupes, requeues and items completed at the
  dispatch-time live check without a run do not. A scheduled admission debits
  when admitted and prepays its own first claim, so it is never charged twice
  for one execution.
- Preserved from https://github.com/openclaw/clawsweeper/pull/1710: organic work
  is always admitted, scheduled work is admitted only with a global balance of
  at least one, debt stops at `-burst`, GitHub throttle feedback pauses
  scheduled admission, and the 30/hour hot cap and lane buckets are unchanged.
- Exercised surface: the real `ExactReviewQueue` Durable Object in workerd with
  SQLite: `/enqueue`, `alarm()` (dispatch-time live check and dispatch),
  `/claim`, `/complete`, `/reconcile`, `/stats`, and persisted reopen across
  base → candidate → base.
- Environment: Node v24.21.0, workerd 1.20260701.1, Miniflare 4.20260701.0
  (from `wrangler@4.107.0` installed with `--ignore-scripts`), fake clock,
  native loopback GitHub fixture with a synthetic RSA credential.

## Command

```sh
node scripts/proof-scheduled-budget.mjs cac974b3e1da900cac3e7480b91d02a36ca60163 <tools-dir> <fresh-output-dir>
```

| Field | Value |
| --- | --- |
| Base (baseline variant) | `cac974b3e1da900cac3e7480b91d02a36ca60163` (main with #1710) |
| Head (candidate variant) | `3febf5e6628f5be132e3d13cc0d35d36d9123d2f`, clean runtime tree |
| Receipt [`result.json`](result.json) SHA-256 | `d6e20c45aacee6efa1711e6461b337841102b100eac74acd10c535956f87f39b` |
| Harness `scripts/proof-scheduled-budget.mjs` SHA-256 | `ceab15aae3afa6396a4fd981e479dc7bc7b7c8dc4e0696668be544f47c371ac9` |
| Head `dashboard/exact-review-queue.ts` SHA-256 | `b527afa1465b4a0b984b548dd380a4689e310e41ba78cc3ba5be4b5540c65123` |
| Head `dashboard/wrangler.toml` SHA-256 | `b059e1e08b4667df581345b2d3bc560089585a5268838cd0cd0ed111d76987cc` |
| `.github/workflows/sweep.yml` SHA-256 (both) | `60ed1e5b2130a7522e404cd0dfb358ae7cd60d819652a367711f56bc619801f1` |

The receipt was copied byte-for-byte from the run's output directory. It
contains no local paths or credentials. Both variants run with the production
`dashboard/wrangler.toml` values: 220/hour, burst 24, hot intake 30/hour,
32 scheduled slots, 80 review slots.

## Production-like scenario

`production_2026_10_01` reproduces the post-#1710 production shape: ~215 new
organic queue items/hour, of which about half read closed at the queue's
dispatch-time live check and are completed without a run, plus organic edits
that supersede a lease while its workflow is still dispatching (the revoked
run's claim is refused). About 5.5% of executed organic reviews request
`requeue_latest`. Scheduled offers follow the production `sweep.yml` cadence.

Hour cells: organic admissions (new/supersede/requeue) · organic executions ·
scheduled admissions (hot + normal) · total executions · scheduled offer
sequences shed on their first candidate.

| Variant | Hour 1 | Hour 2 | Hour 3 |
| --- | --- | --- | --- |
| base | 215 (207/5/3) · 103 · 23 + 13 · 139 · 7/20 | 238 (217/9/12) · 127 · 0 + 0 · 127 · 21/21 | 240 (224/10/6) · 107 · 0 + 0 · 107 · 21/21 |
| head | 215 (207/5/3) · 103 · 35 + 80 · 218 · 0/20 | 238 (217/9/12) · 127 · 30 + 68 · 225 · 2/21 | 240 (224/10/6) · 107 · 30 + 77 · 214 · 2/21 |

- Base: after the initial burst, every scheduled offer is shed and the global
  balance sits at the `-24` floor, as in production. Organic items closed
  before dispatch (103, 100 and 120 per hour) and superseded dispatching
  leases (24 refused claims) were charged without running.
- Head: scheduled admissions are 115, 98 and 107 per hour, close to
  `220 − executed organic`. Hot intake stays at its 30/hour cap after the first
  hour's 8-item hot burst. Total executions are 218, 225 and 214 per hour; the
  largest rolling hour holds 236 executions, below `220 + 24 = 244`. The minimum
  sampled balance is −2.
- Both: every organic arrival is admitted and organic dispatch p95 stays at the
  90-second debounce. Items closed before dispatch never dispatch (asserted).

## No regression in the #1710 scenarios

Total executions per hour (organic + scheduled) and the minimum sampled global
balance:

| Scenario | Base | Head | Min balance base / head |
| --- | --- | --- | --- |
| Organic 130/h | 220, 225, 216 | 221, 227, 220 | −3 / −5 |
| Organic 180/h | 230, 222, 219 | 227, 225, 219 | −6 / −5 |
| Organic 130/h, 30% supersede/requeue | 209, 219, 225 | 209, 229, 222 | −2 / −3 |
| Production-like today (#1710 calibration) | 200, 210, 215 | 207, 227, 220 | −7 / −2 |
| Production-like after lane A | 197, 206, 214 | 200, 207, 214 | −1 / 1 |
| Organic spike 130 → 300 → 130 | 220, 317, 206 | 221, 320, 201 | −24 / −24 |
| Organic 400/h | 406, 397, 367 | 408, 397, 367 | −24 / −24 |
| 400-item spike at minute 20 | 363, 261, 126 | 364, 166, 126 | −21 / −24 |

When every admitted organic item runs, both variants charge each execution once
and behave alike. Organic admission stays at 100% everywhere, the balance never
falls below `-24` (asserted), and sustained organic load above the rate still
sheds scheduled work (the 400/hour rows admit 6 and 8 scheduled items, all in
the first hour's burst).

The 400-item spike shows the one timing difference. Organic work now debits
when it claims, so a scheduled offer half a minute after the spike may still
use the balance that existed before those claims (first scheduled admission at
minute 20.5 on the head versus 28.5 on the base). The debt then stays at the
floor while the spike's claims drain, so the busiest rolling hour holds 437
executions on the head versus 466 on the base, and hour 2 runs 166 versus 261.

Throttle (`throttle_organic_130`), identical on both variants: the throttle
is signalled at minute 75 with `throttle_source: review_completion`; during the
15-minute cooldown 0 scheduled items are admitted, 4 offers are shed and all 31
organic arrivals are admitted; 53 scheduled items are admitted in the 30
minutes after recovery.

## Exactly-once across reconciliation

The `reconciliation` receipt runs admission → dispatch → claim → changed-input
follow-up → `/reconcile` requeue → replayed `/reconcile` → successor dispatch
→ successor claim → same-attempt claim retry, measuring the balance before and
after each step at a frozen clock. Two executions cost exactly two tokens on
both variants (asserted); replays and the claim retry cost none.

| Variant | Charged steps |
| --- | --- |
| base | `admission` 1, `reconcile_requeue` 1 |
| head | `claim` 1, `successor_claim` 1 |

## Persisted upgrade and rollback

Each case reopens the same SQLite Durable Object as base → head → base with the
same worker, class, binding and object identity, at 60/hour burst 6 and at the
production 220/hour burst 24. The base admits the seed work; the head then
admits one organic and, when the balance allows, one scheduled item, dispatches
everything, and claims every lease except the scheduled one.

| Case | Base balance → after upgrade | Claims on head | Balance before → after claims | Rollback balance |
| --- | --- | --- | --- | --- |
| 60/6 positive | 4 → 4 | 3 | 4 → 1 | 1 |
| 60/6 exhausted | 0 → 0 | 7 | 2 → −5 | −5 |
| 60/6 with lane buckets | 3 → 3 | 4 | 3 → −1 | −1 |
| 220/24 positive | 22 → 22 | 3 | 24 → 21 | 21 |
| 220/24 exhausted | 0 → 0 | 25 | 16 → −9 | −9 |
| 220/24 with lane buckets | 21 → 21 | 4 | 24 → 20 | 20 |

- Upgrade at a frozen instant keeps every bucket, item and delivery row
  byte-identical and does not mint a fresh burst.
- On the head, an organic admission debits nothing; a scheduled admission
  debits one token and its row carries `reviewBudgetPrepaid: true`.
- Each claim debits one token down to the floor (asserted). Work the base had
  already charged at admission is charged again when it claims after the
  upgrade: a one-time transient bounded by the in-flight items and absorbed by
  the `-burst` floor. Production currently sits at that floor.
- Rollback reads the same rows and the same carried balance. The base claims
  the prepaid scheduled lease without a debit, preserves the unknown
  `reviewBudgetPrepaid` field, and again debits its own organic admissions.
  Work the head admitted but had not claimed is therefore never charged after
  a rollback: the reverse transient, bounded the same way.

## Regression tests

`test/dashboard-worker-queue-policy.test.ts` covers claimed organic executions
before scheduled backfill, debt repayment, sustained organic load above the
rate, admission/coalesce/replay/supersede-before-claim/publication claims
costing nothing, same-attempt claim retries versus rerun attempts,
completion and reconciliation successors charged once at claim, and the
scheduled prepayment surviving an organic coalesce. All six budget tests fail
on the base and pass on the head.

## Limits

- Organic arrivals, the closed-before-dispatch share, the supersede/requeue
  mix, planner latency and review durations are synthetic but seeded, so reruns
  reproduce the tables. Measured supersede counts are lower than the 12/hour
  target because a lease is dispatching for only one simulated minute.
- An execution is a successful claim. A run that claims and then exits early is
  still charged; one that never claims is not.
- A scheduled item closed or terminal before its claim keeps its admission
  debit; it is not refunded.
- Stale-head pull request deletes, clawhub and other-target supply, and GitHub
  Actions scheduling jitter are not modeled.
- No live inference, production state, deploys or GitHub mutations.

OpenClaw Bay is unaffected: no public status field is added, removed or
renamed, and `scheduled_feed` keeps its shape. The new
`reviewBudgetPrepaid` item field is internal queue state.
