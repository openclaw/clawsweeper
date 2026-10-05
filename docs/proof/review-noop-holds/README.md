# Deterministic review no-op hold proof

On 2026-10-04 `/api/exact-review-queue` reported `review_runaway_health`
`degraded` with `runaway_items: 10`. Two shapes dominated the samples. Open but
locked issues such as
[openclaw/openclaw#56312](https://github.com/openclaw/openclaw/issues/56312)
(queue revision 1800) were re-offered by `scheduled_normal_backfill` every 5-10
minutes; each run (for example
[run 37239862942](https://github.com/openclaw/clawsweeper/actions/runs/37239862942))
claimed the lease, logged that the open conversation is locked, and completed
without Codex. The oversized maintainer draft
[openclaw/openclaw#119055](https://github.com/openclaw/openclaw/pull/119055)
(head `8837ca5974`, unchanged since 2026-10-02) alternated `scheduled_hot_intake`
and `scheduled_normal_backfill` offers: each run (for example
[run 37239631499](https://github.com/openclaw/clawsweeper/actions/runs/37239631499))
took the metadata-only size path, its close was kept open because the PR's
activity exceeds the bounded 300-entry revalidation window, direct publication
threw `was not applied; actions: kept_open`, and the review lease comment's
create/delete moved `updated_at` again. In the trailing ~2 hours of sweep runs,
37 of 117 scheduled review runs were these six items.

Neither outcome writes anything the scheduled planners can see, so the item
stays due forever. This proof shows the queue now holds the completed no-op and
stops the loop, while releasing it on real change.

## Behavior contract

- **Claim:** origin/main claims a new review run for every scheduled offer of an
  open-but-locked issue and of an oversized PR on an unchanged head, so both
  exceed the 24 claimed reviews/day runaway threshold. The branch keeps the
  completed generation parked as `locked_conversation` or
  `oversized_pull_request`; later scheduled offers and automatic recoveries
  dedupe without claiming a run; an organic `unlocked` webhook or a pushed head
  releases the hold; a producer that does not send `review_hold` keeps the old
  behavior.
- **Surface:** the real `ExactReviewQueue` Durable Object routes `/enqueue`,
  `/claim`, `/complete`, `/stats`, and its alarm (dispatcher plus parked terminal
  check); the real dashboard Worker route `GET /api/exact-review-queue`; the
  `/stats` Bay projection.
- **Scenario:** `scheduled_loops` runs 24 simulated hours in 10-minute steps.
  Every step offers #56312 through `scheduled_normal_backfill` and #119055
  through alternating `scheduled_hot_intake` / `scheduled_normal_backfill`, the
  latter with `sourceUpdatedAt` moved to its previous completion. Every
  dispatched run is claimed and completed with the payload the updated
  sweep.yml sends (`outcome: success` plus `review_hold`). It then reads the
  public route, sends a `failed_review_shard_recovery` for #56312, unlocks the
  fixture issue and sends an `issues/unlocked` decision, and finally moves the
  fixture head of #119055 without any webhook and lets the alarm run.
  `legacy_producer` (candidate only) runs two hours with the old completion
  payload, which has no `review_hold`.
- **Command and environment:** see below. Node 24, workerd and Miniflare from a
  `wrangler@4.107.0` install outside the checkout (`--ignore-scripts`),
  SQLite-backed Durable Object, each variant's own `dashboard/wrangler.toml`
  vars, fake clock, and a loopback GitHub fixture with a synthetic RSA
  credential.
- **Observable result:** per-item scheduled offer dispositions, claimed review
  counts, review-lane `parked_reasons`, the Bay projection cards, the public
  `review_runaway_health` and `parked_reasons`, release dispositions, and the
  head the post-push review was dispatched with.
- **Artifact:** [`result.json`](result.json), produced by
  [`run-proof.mjs`](run-proof.mjs).
- **Limits:** the sweep.yml live-check, review, and completion steps are
  reproduced by sending the completion payload they produce, not by running
  GitHub Actions; review execution is replaced by claim plus completion; the
  scheduled planners are reproduced by their enqueue payloads at a fixed
  cadence (the planner-side locked skip is covered by
  `test/review-planning-locked.test.ts`); the five-minute reconcile-parked
  workflow is not run (fresh recovery of a held row is covered by
  `test/exact-review-review-hold.test.ts`). No live inference, production state,
  or GitHub mutation.

## Before and after (24 simulated hours)

| Observation                                     | origin/main                                   | branch                                                                     |
| ----------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------- |
| #56312 scheduled offers / claimed review runs   | 144 / 144 (every offer `queued`)              | 144 / 1 (1 `queued`, 143 `deduped:scheduled_queue_item:locked_conversation`) |
| #119055 scheduled offers / claimed review runs  | 144 / 144 (every offer `queued`)              | 144 / 1 (1 `queued`, 143 `deduped:scheduled_queue_item:oversized_pull_request`) |
| Completion with the new `review_hold` field     | HTTP 200, field ignored                       | HTTP 200, `review_hold` echoed, row parked                                 |
| Review lane after the loop                      | `parked: 0`                                   | `parked: 2` (`locked_conversation: 1`, `oversized_pull_request: 1`)        |
| Public `review_runaway_health`                  | `degraded`, `runaway_items: 2`, both samples  | `healthy`, `runaway_items: 0`                                              |
| Public `parked_reasons`, collection             | n/a                                           | both reasons counted, no `unknown`, collection `complete`                  |
| Bay projection for the held items               | no card (rows deleted)                        | no card (lifecycle owns the completed card), projection `complete`         |
| `failed_review_shard_recovery` while held       | `queued`                                      | `deduped:review_hold:locked_conversation`, no dispatch                     |
| `issues/unlocked` after unlocking               | `queued`                                      | `queued`, review dispatched                                                |
| Head pushed with no webhook                     | n/a (nothing held)                            | first alarm reads `pulls/119055` once and drops the hold; next hot offer `queued` and dispatched on the new head |
| Candidate Worker, old payload, 2 hours          | n/a                                           | 12 / 12 claims per item, nothing parked                                    |

## Reproduce

```sh
npm install --prefix ~/.cache/clawsweeper-proof-tools --no-save --no-audit --no-fund --ignore-scripts wrangler@4.107.0
node docs/proof/review-noop-holds/run-proof.mjs origin/main ~/.cache/clawsweeper-proof-tools .artifacts/review-noop-holds
```

The harness extracts `origin/main` with `git archive`, bundles each variant's
real `dashboard/worker.ts` and `dashboard/exact-review-queue.ts` with esbuild,
and runs both in workerd. It fails unless every assertion in `verify()` holds,
including that the baseline claims every offer.

## Recorded run

RECORDED_RUN_PLACEHOLDER

## OpenClaw Bay

Bay needs no UI change. A held row is a completed review, so the read-model Bay
projection skips it the same way it skips a `scanner_refused` hold and leaves
the item's terminal lifecycle card in place; without that skip the held row
would surface as active `repairing` work (covered by
`test/exact-review-review-hold.test.ts`). The two new parked reasons are counts
on the existing observer-only queue projection; Bay adds no control.
