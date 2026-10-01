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

| Scenario                                  | origin/main `cac974b3e1`         | branch `10f1986374`                                                                                         |
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
- head: `10f1986374f1064ba3f4b4e5adad0ec60f273cba`, `working_tree_dirty: false`
- runtime: Node v24.21.0, workerd 1.20260701.1, Miniflare 4.20260701.0
- `result.json` SHA-256:
  `681503d1d561897fa690f3755a3be3eaf88c3d1e0775afe7644a7efef8a4a4a9`
  (copied byte-for-byte from the run output)
- `run-proof.mjs` SHA-256:
  `ac47946836472d95bd39e90d9b1fca007964bcd386d6076bc9effa2a3f71835e`
- candidate source SHA-256: `dashboard/exact-review-queue.ts`
  `575fdf82f9d698061450f9c5782cbba571119fd0dde8e271180ede9db6ae6238`,
  `dashboard/worker.ts`
  `7712ee6bc17d6a9e3bf9ccd9bd131e6e684761a63aa8f29e6407b067c664430d`
  (all hashed files are listed in the receipt)

The receipt contains no local paths, credentials, or tokens.

## OpenClaw Bay

Bay needs no change. A parked loop uses the existing parked queue state, which
Bay already renders in the `repairing` exception cove with
`queue_disposition: parked`. `review_runaway_health` is a new optional field on
the observer-only queue projection; Bay does not consume it, and it adds no
control. Its sample keys are limited to `PUBLIC_BAY_REPOS`.
