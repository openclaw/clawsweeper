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
  review. An organic webhook event or an explicit command admits it normally.
  `/api/exact-review-queue` reports `review_runaway_health` as `degraded` with
  reason `review_runaway` for an item past 24 claimed reviews in 24 hours.
- **Surface:** the real `ExactReviewQueue` Durable Object routes `/enqueue`,
  `/claim`, `/complete`, `/stats`, and its alarm dispatcher; the real dashboard
  Worker route `GET /api/exact-review-queue`; `summarizeDashboardHealth`.
- **Scenario:** `self_requeue_then_release` reviews issue #97616 once, then after
  every successful generation sends the exact payload of sweep.yml's
  "Queue fresh review after source drift" step (the claimed decision with
  `sourceAction: source_drift_requeue`, `supersedesInProgress: true`, delivery
  `publisher-source-drift:<run>:<n>`) for six cycles, then an `issues/edited`
  decision. `command` loops #123774 four times, then sends a `re_review` command
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

| Scenario                                    | origin/main `cac974b3e1`         | branch `ca1aee4bf5`                                             |
| ------------------------------------------- | -------------------------------- | --------------------------------------------------------------- |
| Source-drift requeues 1-3                   | `queued`, review dispatched      | `queued`, review dispatched                                     |
| Source-drift requeue 4                      | `queued`, review dispatched      | `deduped:source_drift_loop:requeue_limit_reached`, item parked  |
| Source-drift requeues 5-6                   | `queued`, review dispatched      | `deduped:source_drift_loop:item_parked`, no review              |
| Review generations spent (1 organic + 6)    | 7                                | 4                                                               |
| Lane stats while looping                    | no parked item                   | `parked: 1`, `parked_reasons.source_drift_loop: 1`, Bay `repairing` |
| Organic `edited` after the loop             | `queued`                         | `queued`, item `pending`, review dispatched, next requeue `queued` |
| `re_review` command on a looping item       | `queued`, dispatched with marker | `queued` (releases park), dispatched with marker                |
| 25 claimed reviews in 3.3 h, public route   | no `review_runaway_health` field | `degraded` / `review_runaway`, `runaway_items: 1`, sample `openclaw/openclaw#200001`, collection `complete` |
| Dashboard health                            | no runaway reason                | includes `review_runaway` (amber)                               |
| Same history 25 hours later                 | field absent                     | `healthy`, `runaway_items: 0`                                   |

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
- head: `ca1aee4bf5a18bce9aefe2a033b9cd7f8862abbd`, `working_tree_dirty: false`
- runtime: Node v24.21.0, workerd 1.20260701.1, Miniflare 4.20260701.0
- `result.json` SHA-256:
  `247e3ffc8c4fa013b33f6e84ab8a758152e4f8835effb608707ed20db765acc7`
- `run-proof.mjs` SHA-256:
  `6ed9bdb8936fac69f6af7d8977358f3e4d3881cfee527036f7f1fb145666e957`
- candidate source SHA-256: `dashboard/exact-review-queue.ts`
  `3b38d9249ed21fba5bfd72f3f4341367114a53da54013f6e7e58f1c94ba60f0d`,
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
