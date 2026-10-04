# Generation-start review budget charging proof

Status: proof for charging the exact-review budget when a claimed run starts
Codex generation. The owning code is the `/claim` and `/heartbeat` routes and
`chargeStartedReviewGenerationSync` in `dashboard/exact-review-queue.ts`, plus
`verify_startup_authority` in `.github/workflows/sweep.yml`; the contract is
described in [Automation limits](../../limits.md) and
[Scheduler](../../scheduler.md). The earlier
[claim-time charging proof](../scheduled-budget-claim-charging/README.md) is
historical.

## Contract

- Claim: the global review budget meters started review generations. A claim
  records which claim generation owes one token. The workflow's startup
  ownership check, immediately before Codex generation, sends
  `generation_start: true` on the lease heartbeat. The queue charges that
  generation once, or consumes a scheduled prepayment instead. Runs that claim
  and then exit before generation are never charged.
- Retried generation-start heartbeats, ordinary and status heartbeats, stale
  lease tuples, publication and acknowledgement-only claims never charge.
  `generation_start` must be `true` with phase `review`, else `400`.
- Preserved from https://github.com/openclaw/clawsweeper/pull/1710 and
  https://github.com/openclaw/clawsweeper/pull/1736: organic work is always
  admitted, scheduled work needs a global balance of at least one, debt stops
  at `-burst`, GitHub throttle feedback pauses scheduled admission, and the
  30/hour hot cap and lane buckets are unchanged.
- Exercised surface: the real `ExactReviewQueue` Durable Object in workerd with
  SQLite: `/enqueue`, `alarm()` (dispatch-time live check and dispatch),
  `/claim`, `/heartbeat` with `generation_start`, `/complete`, `/reconcile`,
  `/stats`, and persisted reopen across base → head → base. The workflow shell
  that adds `generation_start` is exercised by
  `test/sweep-workflow.test.ts`, which runs the real `verify_startup_authority`
  function against a stubbed control plane.
- Environment: Node v24.21.0, workerd 1.20260701.1, Miniflare 4.20260701.0
  (from `wrangler@4.107.0` installed with `--ignore-scripts`), fake clock,
  native loopback GitHub fixture with a synthetic RSA credential.

## Command

```sh
node scripts/proof-scheduled-budget.mjs 6566c6974a29b61193690f4fcc9a3181ee34c233 <tools-dir> <fresh-output-dir>
```

| Field | Value |
| --- | --- |
| Base (baseline variant) | `6566c6974a29b61193690f4fcc9a3181ee34c233` (main with #1736 and #1737) |
| Head (candidate variant) | `830d2c1f8b3856ac03bde8058cb308449f9c2add`, clean runtime tree |
| Receipt [`result.json`](result.json) SHA-256 | `26cd16811d5b578edcf08adcd392931a515321f8a63b8c52f9d9f1d5b3ae8dda` |
| Harness `scripts/proof-scheduled-budget.mjs` SHA-256 | `ecfc5ca9f862ebe30274a5a6feedda5d7515b48a2db019223f7ffd19597685bc` |
| Head `dashboard/exact-review-queue.ts` SHA-256 | `e92f51e77a4ac9d9f7ba64483e183de4df8b620499498a0c9c442f0a3582585f` |
| Head `.github/workflows/sweep.yml` SHA-256 | `41c5114c24b5b673c1003aab018a3f53e8938b4f94291d6ec6998a83ee84cde5` |

The receipt was copied byte-for-byte from the run's output directory and
contains no local paths or credentials. Both variants run with the production
`dashboard/wrangler.toml` values: 220/hour, burst 24, hot intake 30/hour,
32 scheduled slots, 80 review slots. Both variants receive the same
generation-start heartbeats; the base ignores the field and charges at claim.

## Production scenario: claims that exit before generation

`production_2026_10_01_claims` reproduces production after #1736: about
220 organic claims/hour, of which a third exit before Codex generation
(live-item admission skips, setup supersession). On the live queue the global
balance sat at −3 with scheduled `active` 1 of 32, and every shed was
`scheduled_rate`.

| Variant | Hour 1 | Hour 2 | Hour 3 |
| --- | --- | --- | --- |
| base | claims 239 (67 exit) · started 136 organic + 34 scheduled · admitted hot 21 + normal 13 · min −14 | claims 232 (64 exit) · 169 + 0 · 0 + 0 · min −21 | claims 218 (77 exit) · 141 + 0 · 0 + 0 · min −24 |
| head | claims 292 (67 exit) · started 136 organic + 85 scheduled · admitted hot 35 + normal 52 · min −1 | claims 290 (64 exit) · 169 + 59 · 29 + 29 · min −4 | claims 296 (77 exit) · 141 + 79 · 28 + 50 · min −1 |

- Base: after the first hour the balance sits at the `-24` floor and scheduled
  admission stops, although only about 160 reviews/hour start. The 208 runs
  that exited before generation each spent a token.
- Head: 223 scheduled admissions over three hours instead of 34. Started
  reviews are 669 instead of 480, about 220/hour, which is the budget's target.
  The busiest rolling hour holds 241 started reviews, below `220 + 24 = 244`.
  Scheduled `active` peaks at 26 of 32.
- Both: every organic arrival is admitted.

## No regression elsewhere

Scheduled admissions and started reviews over each scenario:

| Scenario | Scheduled base → head | Started base → head |
| --- | --- | --- |
| Organic 130/h | 263 → 263 | 665 → 666 |
| Organic 180/h | 147 → 149 | 666 → 666 |
| Organic 130/h, 30% supersede/requeue | 304 → 305 | 650 → 651 |
| Production-like today (#1710 calibration) | 258 → 283 | 630 → 651 |
| Production-like after lane A | 367 → 367 | 603 → 603 |
| Throttle at minute 75 | 172 → 169 | 435 → 432 |
| Organic spike 130 → 300 → 130 | 156 → 155 | 736 → 735 |
| Organic 400/h | 8 → 8 | 1166 → 1166 |
| 400-item spike at minute 20 | 246 → 247 | 644 → 644 |
| `production_2026_10_01` (#1736 calibration) | 320 → 320 | 655 → 655 |

When every claim starts generation, both variants charge each execution once,
one simulated minute apart, and the totals match within three. The
production-like-today rise is the intended change on a smaller scale: that
scenario supersedes leased owners, and 21 superseded leases lost authority
during setup, so the head no longer charges them. Organic overload above the
rate still exceeds the allowance by design, because organic work stays
unconditional.

Throttle: on both variants 0 scheduled items are admitted during the 15-minute
pause, 4 offers are shed and 32 organic arrivals are admitted. Afterward, 53
(base) and 50 (head) scheduled items are admitted in the 30 minutes after
recovery.

## Exactly-once across reconciliation

The `reconciliation` receipt runs admission → dispatch → claim → generation
start → retried generation start → changed-input follow-up → `/reconcile`
requeue → replayed `/reconcile` → successor claim → claim retry → successor
generation start → retried successor generation start. It measures the
balance at a frozen clock. Two executions cost exactly two tokens on both
variants (asserted), and replays and retries cost none.

| Variant | Charged steps |
| --- | --- |
| base | `claim` 1, `successor_claim` 1 |
| head | `generation_start` 1, `successor_generation_start` 1 |

## Persisted upgrade and rollback

The proof reopens the same SQLite Durable Object as base → head → base, at
60/hour burst 6 and at the production 220/hour burst 24. Both profiles produce
the same debits.

| Step | Debits |
| --- | --- |
| Base claims two organic leases | 2 (charged at claim) |
| Upgrade: rows and balance identical | 0 |
| Head: generation start for the two base-claimed leases | 0 (no pending-charge marker) |
| Head: claim two organic leases and one scheduled lease | 0 |
| Head: organic generation start, then retried | 1 |
| Head: scheduled generation start | 0 (prepayment consumed) |
| Rollback: rows and balance identical | 0 |
| Rollback: generation start for a lease the head claimed, still in setup | 0 |
| Rollback: base claims a new organic lease | 1 |

The rollout cannot double-charge, because leases the base charged at claim
carry no marker. Two bounded transients remain:

- Runs dispatched before the merge use the old workflow, which does not send
  `generation_start`. If they claim against the new Worker, they are never
  charged.
- After a rollback, leases the head claimed but had not yet started are never
  charged.

Both are bounded by the in-flight review leases, at most 80.

## Regression tests

The tests in `test/dashboard-worker-queue-policy.test.ts` cover:

- claims without a generation start costing nothing;
- one charge per started claim generation, including claim and start retries;
- rerun attempts that exit early versus rerun attempts that start;
- completion and reconciliation successors charged once at start;
- the scheduled prepayment kept across an early exit and consumed at start;
- `invalid_generation_start` validation;
- stale-generation and wrong-run starts being refused;
- ordinary heartbeats being free;
- leases claimed before the rollout not being charged again.

The four tests that encode the new contract fail on the base and pass on the
head. The three load tests pass on both. `test/sweep-workflow.test.ts` runs the
real `verify_startup_authority` function for the owned and superseded
responses, and asserts that both generation paths call it.

## Limits

- Organic arrivals, the closed-before-dispatch and exit-before-generation
  shares, the supersede/requeue mix, planner and setup latency, and review
  durations are synthetic but seeded, so reruns reproduce the tables.
- Exit-before-generation is modeled for organic claims only.
- A scheduled item that exits before generation keeps its prepayment for its
  next started generation. If it is completed instead, the prepayment is not
  refunded.
- Stale-head pull request deletes, clawhub and other-target supply, and GitHub
  Actions scheduling jitter are not modeled.
- No live inference, production state, deploys or GitHub mutations.

OpenClaw Bay is unaffected. No public status field is added, removed or
renamed, and the new `reviewBudgetChargeGeneration` item field is internal
queue state.
