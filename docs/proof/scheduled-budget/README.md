# Scheduled review budget proof

Claim: the exact-review queue charges every organic review execution against
one organic-first budget, so scheduled hot intake and normal backfill fill only
what organic work leaves. With production values of 220 executions/hour, a
24-item burst, hot intake capped at 30/hour, and `openclaw/openclaw` normal
backfill offered every 20 minutes, oldest-first backfill gets its share.
Organic admission stays at 100%, and GitHub throttle feedback still pauses
scheduled admission.

## Budget contract

- Every organic execution debits the global bucket: a new queue item, a
  superseding revision that revokes a dispatching or leased owner, and a
  completion requeue for new review input. Pending coalesces, dedupes,
  publication work, and same-revision retries are not charged.
- Scheduled admission is bounded. It requires a global balance of at least
  one, so scheduled work only spends positive balance and never takes more
  than rate + burst.
- Organic work is unbounded by design: it is always admitted. It can take the
  global balance down to minus one burst; debt beyond that floor is dropped,
  and scheduled admission repays the carried debt before it resumes.
- Total executions over time therefore stay within max(rate, organic rate) +
  burst, and scheduled admission receives almost nothing while organic work
  runs at or above the rate.

A single 60-minute window can exceed rate + burst by the organic debt still
outstanding at the window's end. The 180/hour organic scenario shows this. Its
busiest window (minutes 10–70) held 173 organic and 72 scheduled executions:
245 against a 244 ceiling. The global balance there reached −6, and later
scheduled offers were shed until the debt was repaid. The excess is organic
credit, not scheduled overspend.

The organic spike scenario (130, then 300, then 130 new keys per hour) shows the
unbounded side. During the 300/hour hour, 320 organic executions were admitted
and scheduled admission fell to 11 (2 hot, 9 normal).
The global balance sat at the −24 floor, and the busiest window held 321
organic and 11 scheduled executions. After the spike, the carried debt of up to
24 executions was repaid at the net ~90/hour left by 130/hour organic, and
scheduled admission resumed: 62 in the following hour, against 84 before the
spike.

## Harness

[`proof-scheduled-budget.mjs`](../../../scripts/proof-scheduled-budget.mjs)
bundles the base and candidate `ExactReviewQueue` into real workerd SQLite
Durable Objects, one isolated instance per scenario. It advances a fake clock
and delivers alarms when the queue asks for them. Each revision's own
`dashboard/wrangler.toml` variables and `.github/workflows/sweep.yml` crons
configure its variant.

Organic load has three parts, all seeded:

- new keys: `issues/opened` with Poisson arrivals;
- supersedes: `issues/edited` with `supersedesInProgress` against a random
  active organic owner;
- requeues: `requeue_latest` completions, sampled with a fixed probability.

Scheduled offers follow `scheduled-review-enqueue`: fresh candidates until the
first shed. Hot offers run at `*/5` and `4/20`, normal offers at the direct
and fanout crons. Direct planners land 3 minutes after the cron and fanout
planners 6 minutes after. Every admitted item is dispatched to a loopback
GitHub fixture, claimed after 1 minute, and completed after 4–10 minutes. The
throttle scenario reports `retry_kind: throttle` on the first completion after
minute 75.

```sh
npm install --prefix /tmp/clawsweeper-proof-tools --no-save --no-audit --no-fund --ignore-scripts wrangler@4.107.0
node scripts/proof-scheduled-budget.mjs 1b2c262b6bfca5c7c18a9104478e173b2ea0a53c /tmp/clawsweeper-proof-tools .artifacts/scheduled-budget
```

The output directory must be a subdirectory of the checkout's `.artifacts/`
directory. The harness refuses to replace an existing non-empty directory it
did not create.

Recorded run:

| Field | Value |
| --- | --- |
| Base | `1b2c262b6bfca5c7c18a9104478e173b2ea0a53c` (main, including #1709) |
| Head | `85d38e6940365498b6482d1d32d33f3744203d93` (clean tree) |
| Runtime | Node v24.21.0, workerd 1.20260701.1, miniflare 4.20260701.0 |
| Base cadence | normal `1 * * * *` direct + `41 * * * *` fanout; rate 60, burst 6 |
| Head cadence | normal `9/20 * * * *` direct + `14/20 * * * *` fanout; rate 220, burst 24, hot 30 |
| Harness sha256 | `0a0da1fe66baf579900ef9eba663051be7214805b32fbd3b6c1ab5924c7da606` |
| `result.json` sha256 | `90885f730c400addaeb5c902c20e274cb70632b9fce4a1145b0a4c0a7e12bba6` |
| Head `dashboard/exact-review-queue.ts` sha256 | `c0dc198d56fd407ac10ed4e42bb3b978b17b1c9d3c3dde8657d26381eea53d0a` |
| Head `dashboard/wrangler.toml` sha256 | `17373ec90e5057679d1bab96d570166d868592b1053904b3633516c1bf8f55d6` |
| Head `.github/workflows/sweep.yml` sha256 | `33ca5969022cf5b268e7a405db2f535056a2de64c3baa5c81941a44c4e0ebd2e` |

The six scenarios carried over from the previous recorded run (head
`15fcdf6cf07f`) reproduce identical numbers; the base now includes #1709,
which does not touch the queue, its configuration, or the cron routing.

## Observed results

Each hour cell reads `organic (new/supersede/requeue) + hot + normal = total
executions`. The ceiling is rate + burst: 66 on the base, 244 on the head.
"Production-like today" uses ~45 new keys and ~135 supersedes/requeues per
hour. That mix reproduces live base telemetry: hot ~19.5/hour, normal
~4.2/hour, about 24 scheduled/hour. "After lane A" removes ~65/hour of
source-drift requeues.

| Scenario | Variant | Hour 1 | Hour 2 | Hour 3 | Rolling 60 min max / ceiling | Min balance | Max scheduled active |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Organic 130/h, new keys | base | 142 + 4 + 0 = 146 | 131 + 4 + 0 = 135 | 138 + 4 + 0 = 142 | 157 / 66 | 0 | 2 / 32 |
| Organic 130/h, new keys | head | 142 + 35 + 49 = 226 | 131 + 28 + 66 = 225 | 138 + 32 + 46 = 216 | 238 / 244 | -3 | 30 / 32 |
| Organic 180/h, new keys | base | 165 + 1 + 0 = 166 | 180 + 1 + 0 = 181 | 187 + 0 + 0 = 187 | 198 / 66 | 0 | 1 / 32 |
| Organic 180/h, new keys | head | 165 + 31 + 39 = 235 | 180 + 34 + 11 = 225 | 187 + 21 + 11 = 219 | 245 / 244 | -6 | 25 / 32 |
| Organic 130/h, 30% supersede/requeue | base | 117 (83/21/13) + 4 + 4 = 125 | 121 (89/18/14) + 4 + 2 = 127 | 138 (101/19/18) + 6 + 2 = 146 | 147 / 66 | 0 | 4 / 32 |
| Organic 130/h, 30% supersede/requeue | head | 117 (83/21/13) + 35 + 66 = 218 | 121 (89/18/14) + 30 + 68 = 219 | 138 (101/19/18) + 30 + 66 = 234 | 237 / 244 | -2 | 29 / 32 |
| Production-like today | base | 126 (36/57/33) + 18 + 8 = 152 | 129 (39/61/29) + 15 + 5 = 149 | 147 (34/62/51) + 18 + 6 = 171 | 185 / 66 | 0 | 7 / 32 |
| Production-like today | head | 126 (36/57/33) + 35 + 63 = 224 | 138 (39/61/38) + 26 + 63 = 227 | 159 (34/62/63) + 32 + 25 = 216 | 235 / 244 | -7 | 31 / 32 |
| Production-like after lane A | base | 99 (36/34/29) + 18 + 8 = 125 | 84 (39/29/16) + 15 + 5 = 104 | 84 (34/24/26) + 18 + 6 = 108 | 128 / 66 | 0 | 7 / 32 |
| Production-like after lane A | head | 99 (36/34/29) + 35 + 77 = 211 | 84 (39/29/16) + 30 + 95 = 209 | 86 (34/24/28) + 30 + 96 = 212 | 227 / 244 | -1 | 31 / 32 |
| Throttle at minute 75, organic 130/h | base | 142 + 4 + 0 = 146 | 131 + 3 + 0 = 134 | — | 148 / 66 | 0 | 2 / 32 |
| Throttle at minute 75, organic 130/h | head | 142 + 35 + 49 = 226 | 131 + 28 + 59 = 218 | — | 238 / 244 | -3 | 30 / 32 |
| Organic spike 130 → 300 → 130/h | base | 142 + 4 + 0 = 146 | 320 + 0 + 0 = 320 | 130 + 0 + 1 = 131 | 321 / 66 | 0 | 2 / 32 |
| Organic spike 130 → 300 → 130/h | head | 142 + 35 + 49 = 226 | 320 + 2 + 9 = 331 | 130 + 28 + 34 = 192 | 332 / 244 | -24 | 30 / 32 |

The base never charges supersedes or requeues and forgives organic debt on
read. As a result its rolling totals run well above its own 66-execution
ceiling while scheduled work is starved.

On the head:

- Organic admission is 100% in every scenario, and organic dispatch p95 stays
  at the 90-second debounce.
- Normal backfill averages 54/hour at 130/hour new-key organic and 67/hour with
  the 30% supersede/requeue mix. It gets 25–63/hour on today's production-like
  load and 77–96/hour after lane A.
- Hot intake stays near its 30/hour cap. The first hour includes the 8-item
  hot burst.
- During the 300/hour organic spike, per-hour minimum balances were −3, −24
  and −22. The balance never went below the −24 floor in any scenario (the
  harness asserts this).

Throttle, on both variants:

- The throttle is signalled at minute 75.05.
- Stats report `throttle_source: review_completion` with recovery 15 minutes
  later.
- During the cooldown, 0 scheduled executions are admitted: the head sheds 4
  offers and the base sheds 3. All 31 organic arrivals in that window are
  admitted.
- In the 30 minutes after recovery, the head admits 53 scheduled executions and
  the base admits 3.

Supersedes produce the expected stale-lease conflicts: in the production-like
run, 40 claims and 136 completions. They are counted, not treated as failures.

## Limits

GitHub is a native loopback fixture with a synthetic RSA credential. Organic
arrivals, the supersede/requeue mix, planner latency, and review durations are
synthetic but seeded, so reruns reproduce the table. The proof exercises the
real queue admission, token buckets, supersession, requeue, dispatch, claim,
completion, throttle feedback, alarms, and SQLite storage.

It does not call live inference, mutate GitHub, or alter production state.
Clawhub and other-target supply and GitHub Actions scheduling jitter are not
modeled. Candidate supply is unlimited, which is the pessimistic case for the
budget and for the normal-backfill share.

OpenClaw Bay is unaffected. No public field is added or removed, and
`scheduled_feed.target_rate_per_hour` only changes value.
