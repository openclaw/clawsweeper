# Source-drift loop breaker and runaway alert proof

openclaw/openclaw#97616 reached exact-review revision 548 and #123774 reached
284: each was re-reviewed about every eight minutes through
`source_drift_requeue`, and nothing alerted. This proof shows the queue now
stops such a self-feeding loop after three automatic generations, releases it on
real input, leaves command reviews alone, and reports any item that still runs
away.

## Behavior contract

- **Claim:** origin/main admits a `source_drift_requeue` after every successful
  review generation indefinitely. The branch admits three consecutive automatic
  generations, then parks the item as `source_drift_loop` and spends no further
  review. An organic webhook event or an explicit command admits it normally
  and restarts the count. A scheduled offer newer than the park releases one
  review without restarting the count, so that review's next drift requeue
  re-parks at once. `/api/exact-review-queue` reports `review_runaway_health` as `degraded` with
  reason `review_runaway` for an item past 24 claimed reviews in 24 hours.
- **Surface:** the real `ExactReviewQueue` Durable Object routes `/enqueue`,
  `/claim`, `/complete`, `/stats`, and its alarm dispatcher; the real dashboard
  Worker route `GET /api/exact-review-queue`; `summarizeDashboardHealth`.
- **Scenario:** `self_requeue_then_release` reviews issue #97616 once, then after
  every successful generation sends the exact payload of sweep.yml's
  "Queue fresh review after source drift" step (the claimed decision with
  `sourceAction: source_drift_requeue`, `supersedesInProgress: true`, delivery
  `publisher-source-drift:<run>:<n>`) for six cycles, then an `issues/edited`
  decision. `scheduled_release` loops #97618 four times, sends a
  `scheduled_normal_backfill` offer whose `sourceUpdatedAt` is one minute after
  the park, runs that review, and sends its drift requeue. `command` loops
  #123774 four times, then sends a `re_review` command
  with a status marker. `runaway` claims and completes 25 reviews of #200001
  within 3.3 simulated hours and reads the public route, then advances 25 hours.
- **Command and environment:** see below. Node 24, workerd and Miniflare from a
  wrangler 4 install outside the checkout, SQLite-backed Durable Object, fake
  clock, and a loopback GitHub fixture with a synthetic RSA credential.
- **Observable result:** enqueue dispositions, queue state and lane
  `parked_reasons` after each requeue, dispatched review counts, the public
  `review_runaway_health` object, and the dashboard health reasons.
- **Artifact:** [`result.json`](result.json), produced by
  [`run-proof.mjs`](run-proof.mjs).
- **Limits:** issue items only (the breaker has no item-kind branch; the pull
  request `synchronize` release is covered by
  `test/exact-review-source-drift-loop.test.ts`). The publisher step is
  reproduced by its payload, not by running GitHub Actions, and review execution
  is replaced by claim plus successful completion. The dashboard health call
  passes only the queue snapshot, so `workflow_execution_degraded` in that output
  reflects the absent operational section, not the change. No live inference,
  production state, or GitHub mutation.

## Before and after

| Scenario                                  | origin/main `cac974b3e1`         | branch `2f91363b9d`                                                                                         |
| ----------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Source-drift requeues 1-3                 | `queued`, review dispatched      | `queued`, review dispatched                                                                                 |
| Source-drift requeue 4                    | `queued`, review dispatched      | `deduped:source_drift_loop:requeue_limit_reached`, item parked                                              |
| Source-drift requeues 5-6                 | `queued`, review dispatched      | `deduped:source_drift_loop:item_parked`, no review                                                          |
| Review generations spent (1 organic + 6)  | 7                                | 4                                                                                                           |
| Lane stats while looping                  | no parked item                   | `parked: 1`, `parked_reasons.source_drift_loop: 1`, Bay `repairing`                                         |
| Organic `edited` after the loop           | `queued`                         | `queued`, item `pending`, review dispatched, next requeue `queued`                                          |
| Newer scheduled offer after the loop      | `queued`, reviewed               | `queued`, one review dispatched                                                                             |
| Drift requeue after that scheduled review | `queued`, another review         | `deduped:source_drift_loop:requeue_limit_reached`, re-parked, no further review                             |
| Reviews spent in the scheduled scenario   | 7                                | 5 (1 organic + 3 drift + 1 scheduled)                                                                       |
| `re_review` command on a looping item     | `queued`, dispatched with marker | `queued` (releases park), dispatched with marker                                                            |
| 25 claimed reviews in 3.3 h, public route | no `review_runaway_health` field | `degraded` / `review_runaway`, `runaway_items: 1`, sample `openclaw/openclaw#200001`, collection `complete` |
| Dashboard health                          | no runaway reason                | includes `review_runaway` (amber)                                                                           |
| Same history 25 hours later               | field absent                     | `healthy`, `runaway_items: 0`                                                                               |

## Reproduce

```sh
npm install --prefix /tmp/clawsweeper-proof-tools --no-save --no-audit --no-fund wrangler@4
node docs/proof/source-drift-loop-breaker/run-proof.mjs origin/main /tmp/clawsweeper-proof-tools .artifacts/source-drift-loop-breaker
```

The harness extracts `origin/main` with `git archive`, bundles each variant's
real `dashboard/worker.ts`, `dashboard/exact-review-queue.ts`, and
`dashboard/dashboard-health.ts` with esbuild, and runs both in workerd with each
variant's own `dashboard/wrangler.toml` vars. It fails unless every candidate
assertion holds and the baseline requeues on every cycle.

## Recorded run

- base: `cac974b3e1da900cac3e7480b91d02a36ca60163` (origin/main)
- head: `2f91363b9d6081ea7ae4e4ea31450e3a3ec5feb7`, `working_tree_dirty: false`
- runtime: Node v24.21.0, workerd 1.20260701.1, Miniflare 4.20260701.0
- `result.json` SHA-256:
  `0ade9bf73112f316d7c8fc35613a1f90cf26dc70a932a57af244958c341599a1`
  (copied byte-for-byte from the run output)
- `run-proof.mjs` SHA-256:
  `ac47946836472d95bd39e90d9b1fca007964bcd386d6076bc9effa2a3f71835e`
- candidate source SHA-256: `dashboard/exact-review-queue.ts`
  `88c4679c05778f93f74598b971c41720dc75b1a924bb6ccfe8cf2d70447b6c01`,
  `dashboard/worker.ts`
  `7712ee6bc17d6a9e3bf9ccd9bd131e6e684761a63aa8f29e6407b067c664430d`
  (all hashed files are listed in the receipt)

The receipt contains no local paths, credentials, or tokens. The idle-counter
expiry fix (`3727687379`) is covered by the unit test "an expired exhausted
counter never denies admission and is not resurrected", which fails on the
previous head `626dd230c8`.

## Persisted upgrade and rollback proof

[`upgrade-and-rollback.mjs`](upgrade-and-rollback.mjs) persists one
SQLite-backed `ExactReviewQueue` Durable Object on disk and reopens it with the
real dashboard Worker three times: origin/main, then the branch, then
origin/main again. Raw rows are read directly from SQLite before each variant's
first queue request.

| Phase                            | What happens                                                                                                        | Result                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| origin/main creates state        | #300001 pending (organic), #300002 leased, #300003 parked `scanner_refused`, #300004 pending `source_drift_requeue` | lane: 2 pending, 1 leased, 1 parked; no new tables                                                                       |
| Branch reopens                   | raw item and delivery rows before and after the first queue read                                                    | byte-identical to the origin/main snapshot                                                                               |
| Branch finishes origin/main work | completes the #300002 lease, dispatches #300001 and #300004                                                         | all completed                                                                                                            |
| Branch loop parking              | #300005, #300006, #300010 each get 3 admitted drift generations                                                     | 4th requeue `requeue_limit_reached` for all three; 12 reviews spent                                                      |
| Branch operator path             | `/parked-reviews/list` and `recover-fresh`                                                                          | lists all three `source_drift_loop` rows; recovers #300005 to pending                                                    |
| Branch leaves work               | #300005 and #300007 leased, #300008 pending, #300006 and #300010 parked                                             | both new tables created                                                                                                  |
| origin/main reopens              | raw items, deliveries, loop counters, and generation rows                                                           | byte-identical to the branch snapshot; new tables ignored                                                                |
| origin/main reads                | `/stats` and public `GET /api/exact-review-queue`                                                                   | 200, collection `complete`; `source_drift_loop: 2` in stats, folded into public `unknown: 2`; no `review_runaway_health` |
| origin/main finishes branch work | completes the #300007 and #300005 leases                                                                            | both completed                                                                                                           |
| Parked loop, automatic requeue   | `source_drift_requeue` for #300006                                                                                  | ignored as low-priority recovery; row stays parked                                                                       |
| Parked loop, organic event       | `edited` for #300006                                                                                                | queued; pending; dispatched and completed                                                                                |
| Parked loop, command             | `re_review` for #300010                                                                                             | queued; pending; dispatched                                                                                              |
| End state                        | remaining rows                                                                                                      | only #300003 (`scanner_refused`) and the dispatched #300010; nothing lost                                                |

All 14 assertions pass. Reproduce with:

```sh
node docs/proof/source-drift-loop-breaker/upgrade-and-rollback.mjs origin/main /tmp/clawsweeper-proof-tools .artifacts/source-drift-loop-upgrade
```

- base `cac974b3e1da900cac3e7480b91d02a36ca60163`, head
  `2f91363b9d6081ea7ae4e4ea31450e3a3ec5feb7`, `working_tree_dirty: false`
- [`upgrade-and-rollback.json`](upgrade-and-rollback.json) SHA-256:
  `a47f5a5f0760c087b348be13a564a192f7d60fd4b945ceee92bdc2a684350d63`
  (copied byte-for-byte from the run output)
- `upgrade-and-rollback.mjs` SHA-256:
  `82e3fc04e23caf32d71c2e2ddbf914b6e601af7357a3665509990f94d01e9a7e`
- row digests: origin/main items
  `bb1be102b61e72d144bf60e46804920a550c46e5ac4755f697f0456fe8395d6b`, branch
  items `acfe23c230ed62813e88ddfc4a9851f5cd12fd200a4f9f37009ae28b383e642e`
  (all digests and source hashes are in the receipt)

Limits: one Durable Object persisted by Miniflare on local disk, not a
production Cloudflare deployment; synthetic GitHub fixture; issue items only;
review execution replaced by claim plus completion; alarms only by explicit
fake-clock ticks. On origin/main a parked loop row is not operator-listable
(its parked-reason allowlist predates `source_drift_loop`), but organic events
and commands release it as above.

## OpenClaw Bay

Bay needs no change. A parked loop uses the existing parked queue state, which
Bay already renders in the `repairing` exception cove with
`queue_disposition: parked`. `review_runaway_health` is a new optional field on
the observer-only queue projection; Bay does not consume it, and it adds no
control. Its sample keys are limited to `PUBLIC_BAY_REPOS`.

## Direct lifecycle requeues (#1932)

[PR 1932](https://github.com/openclaw/clawsweeper/pull/1932) applies the same
breaker to direct publication completion and reconciliation. The existing
scripts now also drive signed Worker `publication-results` requests with
`lifecycle.kind: requeue`, then `lifecycle/terminal-disposition`, then either
`complete` with `direct_lifecycle_requeue: true` or a successful run through
`reconcile`. Each completed revision must keep its `requeue` lifecycle fact.

| Scenario                                            | Base                                                                          | Candidate                                                                                                             |
| --------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Direct completion                                   | Six requeues; seven dispatches                                                | Three successor dispatches; fourth successor parked; four total dispatches                                            |
| Reconciliation                                      | Six requeues; seven dispatches                                                | Same limit; later alarms dispatch nothing                                                                             |
| Issue `edited` and PR `synchronize` with a new head | New review admitted                                                           | Park released; counter reset to one after the next direct requeue                                                     |
| Explicit `re_review`                                | New review admitted                                                           | Park released; command-context direct requeue not counted                                                             |
| Stats and public projection at limit                | No park                                                                       | `parked_reasons.source_drift_loop: 1`                                                                                 |
| Persisted upgrade                                   | Lease with accepted direct requeue, pending drift work, two existing counters | Raw rows unchanged on reopen; old lease advances counter from one to two; later reconciliation parks with no dispatch |
| Persisted rollback                                  | Reopens candidate state                                                       | Raw rows unchanged; parked row served; organic edit releases it and dispatches one review                             |

Dispatch totals include the first organic review. The base's final dispatched
review is completed without a direct requeue before the release comparison.
The persisted proof reads raw item, delivery, counter, generation, and lifecycle
rows before the first queue request and after the first read.

```sh
node docs/proof/source-drift-loop-breaker/run-proof.mjs origin/main /tmp/clawsweeper-proof-tools /tmp/direct-requeue-proof direct
node docs/proof/source-drift-loop-breaker/upgrade-and-rollback.mjs origin/main /tmp/clawsweeper-proof-tools /tmp/direct-requeue-upgrade direct
```

Use the same `wrangler@4` install shown above and fresh output directories.
Both modes share the existing Worker harness. Miniflare 5 uses
`convertV4MiniflareOptions` and `resourcePersistencePath`; its adapter does not
carry the older `durableObjectsPersist` option. All outbound requests go to the
loopback fixture. The target predicate admits the fixture repository; the
Worker still checks visibility against the fixture. An alarm tick advances
eleven minutes, past the configured debounce. There is no production access,
GitHub mutation, Actions execution, or model inference.

Recorded run: pueue task `3768`, exit `0`; Node `v24.21.0`, workerd
`1.20261006.1`, Miniflare `5.20261006.1-alpha`. The two direct modes pass all
eight assertion groups. Both original scenarios also pass with their original
baseline `cac974b3e1da900cac3e7480b91d02a36ca60163`.

- Direct base: `472765315dd11b112847ed39a0b2e7d9912f293b`.
- Candidate product source: `2930a5ae888c198b8c1472854699951d2a29e6b6`;
  this proof-only change does not change product code.
- [`direct-requeue-result.json`](direct-requeue-result.json) SHA-256:
  `9b97ef886f49b6771190391d64ec63d0243590bb0848719f0269995aad7e537a`.
- [`direct-requeue-upgrade-and-rollback.json`](direct-requeue-upgrade-and-rollback.json)
  SHA-256: `3757bd0678f22dda555a6ee86eb525f84c7e971b791fde4f77299e9d49c4c99b`.
- `run-proof.mjs` SHA-256:
  `5a04c731f23cc54076cfa236c86190adc76b586e32bced7df82ea4136f6b29a8`.
- `upgrade-and-rollback.mjs` SHA-256:
  `fdfa6cd7950521f45b6f18ce74bddfed3608626c4c2877f79e91622d63eaea79`.
- Candidate `dashboard/exact-review-queue.ts` SHA-256:
  `f6541de8ef6842bf4ff23082a14903964ee3e285e7fb33a32b131b729e0e5e4e`.
- Candidate `dashboard/worker.ts` SHA-256:
  `a375171775e7e2649545f96d13ea4309179598f6c7a3d4bff02454b0cd5b6bb7`.

Both receipts were copied byte-for-byte from the run output. They contain no
local paths, credentials, or tokens. Bay needs no change: this path uses the
existing parked state and reason and adds no public field or action control.
