# Scheduled review budget proof

Claim: the exact-review queue debits organic admissions and new-input successors
against the scheduled admission budget. With the proposed values of 220 admissions/hour, a
24-item burst, hot intake capped at 30/hour, and `openclaw/openclaw` normal
backfill offered every 20 minutes, oldest-first backfill gets its share.
Organic admission stays at 100%, and GitHub throttle feedback still pauses
scheduled admission.

## Budget contract

- Every organic admission debits the global bucket: a new queue item, a
  superseding revision that revokes a dispatching or leased owner, and a
  completion or reconciliation requeue for new review input. Pending coalesces, dedupes,
  publication work, and same-revision retries are not charged.
- Organic work is always admitted. It may leave the global bucket up to one
  burst in debt, and scheduled admission repays that debt before it resumes.
- Scheduled admission requires a global balance of at least one. Scheduled work
  alone is bounded by the refill rate plus the initial burst.
- This is **not a total-work or spend cap**. Organic admission is unconditional,
  and debt stops at `-burst`; further organic debits at that floor are forgotten.
  Sustained organic load can exceed the target indefinitely, and scheduled work
  can resume once bounded debt refills even if an earlier spike remains in the hour.

The original 180/hour scenario already exceeds the 244 scheduled allowance:
its busiest window held 173 organic and 72 scheduled admissions. That example
does not bound larger organic spikes. The harness now also exercises sustained
400/hour organic load and a concentrated 400-item spike followed by recovery.

The reported unit is admissions and new-input successors, not executed model
calls. Admitted work may be superseded before dispatch, and same-input retries
are not charged again. Actual dispatch counts are reported separately.

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

Choose an unused output directory. Existing directories, files and symlinks
are refused without removing their contents.

## Persisted upgrade and rollback

The harness also closes and reopens the same SQLite Durable Object across
baseline → candidate → baseline, preserving its Worker, class, binding and
object identity. It covers both retaining 60/hour with burst 6 and the proposed
220/hour with burst 24. Each configuration starts with a partially spent
balance, an exhausted balance, the legacy persisted `-1` balance, and a separate
fixture with both hot and normal lane buckets populated by actual admissions.

At a frozen clock, upgrade must retain every bucket, queue item and delivery
record exactly and must not grant a fresh burst. Additional organic admissions
then reach the candidate's debt floor. Rollback must reopen those same records;
the old code displays a negative balance as zero and forgives the persisted
debt on the next admission attempt. An immediate scheduled offer is shed, and
a different item offered one minute later is admitted under the restored 60/hour
rate. Rollback therefore restores the old accounting semantics; it does not
preserve the candidate's debt repayment delay.

The receipt records each case in `upgrade_rollback`, including queue/delivery
row hashes. This is real workerd/SQLite persistence with synthetic input and a
controlled clock, not a Cloudflare deployment or approval to raise live rates.

All eight cases passed on AWS Crabbox lease `cbx_36bc5d811d57`, image
`ami-0461d919be7deb53c`, Node 24.18.1. The
[compact receipt](upgrade-and-rollback.json) records the source fingerprints
and [provider run](https://crabbox.openclaw.ai/portal/runs/run_e83abfd93218638403762c9fb6d856af).
The runtime inputs match `4c1feb68dfd108d752c4a842a8c29ff563b80551`; the harness
was a proof-only overlay whose SHA-256 is recorded separately.

## Overload and reconciliation verification

[Compact receipt](overload-and-reconciliation.json) records the corrected
source hashes, configuration, actual dispatch counts, and limits. This is
controlled validation of the proposed 220/24 settings, not rollout approval.
The receipt predates integration of the subsequent author and main updates;
https://github.com/openclaw/clawsweeper/pull/1710 carries current-candidate
validation separately. These source hashes describe the recorded run.

The run used AWS Crabbox lease `cbx_908d6c2293ca`, image
`ami-0461d919be7deb53c`, Node 24.18.1, workerd 1.20260701.1 and Miniflare
4.20260701.0, against base `c1a83a00a73a800f45ff67ef5c7677ba4f17a8da`.
Candidate source was an uncommitted overlay on `d013ad8f3c6d`; the receipt's
source fingerprints identify the executed files.

```sh
PROOF_SCENARIOS=organic_400_above_target,organic_spike_then_recovery,throttle_organic_130 \
  node scripts/proof-scheduled-budget.mjs c1a83a00a73a800f45ff67ef5c7677ba4f17a8da \
  /tmp/clawsweeper-proof-tools .artifacts/budget-triage-proof-1
```

| Observation | Baseline | Candidate |
| --- | --- | --- |
| Sustained organic load: admissions in three hours | 411, 402, 365 | 417, 402, 365 |
| Sustained load: largest rolling hour | 417 | 418 |
| 400-item spike: largest rolling hour | 427 | 514 |
| First scheduled admission after minute-20 spike | minute 23.5 | minute 28.5 |
| New-input successor recovered by reconciliation | balance 6 → 6 | balance 24 → 23 |
| Replayed reconciliation | zero debits | zero debits |
| Scheduled admissions during throttle cooldown | zero | zero |

Both variants admitted all 31 organic arrivals during the throttle cooldown.
The candidate's scheduled concurrency stayed at or below 32. The spike and
sustained-load observations demonstrate why 244 is not a combined admission
ceiling. The reconciliation control exercises actual enqueue, alarm, claim,
changed-input enqueue, reconciliation, and replay paths in workerd/SQLite.

Five focused tests passed, including output preservation for existing
directories, the working directory, parent directories, files and symlinks,
and direct-completion/reconciliation debit parity. Both new regressions failed
on the original branch. The full check passed with 7,029 tests passed, 19
skipped and zero failures; its first attempts exposed a stale documentation
assertion and an incorrectly placed runner flag, both corrected before the
passing run. Provider run links are in the receipt.

## Initial normal-load verification

Recorded earlier run (before exclusive output creation and the reconciliation
correction):

| Field | Value |
| --- | --- |
| Base | `1b2c262b6bfca5c7c18a9104478e173b2ea0a53c` (main, including https://github.com/openclaw/clawsweeper/pull/1709) |
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
`15fcdf6cf07f`) reproduce identical numbers; the base now includes https://github.com/openclaw/clawsweeper/pull/1709,
which does not touch the queue, its configuration, or the cron routing.

## Observed results

Each hour cell reads `organic (new/supersede/requeue) + hot + normal = total
admissions`. The scheduled allowance is rate + burst: 66 on the base, 244 on the head;
it is not a ceiling for the combined total.
"Production-like today" uses ~45 new keys and ~135 supersedes/requeues per
hour. That mix reproduces live base telemetry: hot ~19.5/hour, normal
~4.2/hour, about 24 scheduled/hour. "After lane A" removes ~65/hour of
source-drift requeues.

| Scenario | Variant | Hour 1 | Hour 2 | Hour 3 | Rolling 60 min admissions / scheduled allowance | Min balance | Max scheduled active |
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
read. Its rolling totals run above the 66-admission scheduled allowance while
scheduled work is starved; unconditional organic admission permits this on either variant.

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
