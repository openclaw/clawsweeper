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

- base: `dd58d9ec74fbfa5f757caab1b24c07194bef6f2b` (origin/main)
- head: `56214cc1928851cf8f1fc3501a375cc2d38c1045`, `working_tree_dirty: false`
- runtime: Node v24.21.0, workerd 1.20260701.1, Miniflare 4.20260701.0
- `result.json` SHA-256:
  `e8412a5bfaf18a6e56029281550afc3b300b108cd075140e697dd7eb16d0c17b`
  (copied byte-for-byte from the run output)
- `run-proof.mjs` SHA-256:
  `38a4af8f50b140922d91d4e40abcf5187f8f32b8b1a6b7807eac9201ac719802`
- candidate source SHA-256: `dashboard/exact-review-queue.ts`
  `9b9c70aa4b7ee80e698bab796b7480605d79f6d3d49bef8efbdddad7f6862560`,
  `.github/workflows/sweep.yml`
  `1b384c455470b758cceef72802c26d60e4bb7704adab8b845a7cbd18205f9181`
  (all hashed files are listed in the receipt)

All 16 assertions pass. The receipt contains no local paths, credentials, or
tokens. Across twelve local runs of this harness on this loaded host (load
average 30-60), one exited during the candidate phase without a receipt or
diagnostic; the other eleven, including this recorded run, passed.

## Persisted upgrade and rollback proof

[`upgrade-and-rollback.mjs`](upgrade-and-rollback.mjs) persists one
SQLite-backed `ExactReviewQueue` Durable Object on disk and reopens it with the
real dashboard Worker three times: origin/main, then the branch, then
origin/main again. Raw item and delivery rows are read directly from SQLite
before and after each variant's first queue request.

| Phase | What happens | Result |
| --- | --- | --- |
| origin/main creates state | #400001 pending, #400002 leased, #400003 parked `scanner_refused` | lane: 1 pending, 1 leased, 1 parked |
| Branch reopens | raw item and delivery rows before and after the first queue read | byte-identical to the origin/main snapshot |
| Branch finishes origin/main work | completes the #400002 lease, dispatches and completes #400001 | both completed |
| Branch holds no-ops | scheduled offers for locked #56312, #38283, #40088 and oversized #119055, #119056, completed with `review_hold` | three `locked_conversation`, two `oversized_pull_request`; `scanner_refused` kept |
| Branch dedupes and lists | a repeat scheduled offer per held item; `/parked-reviews/list` | every offer `deduped:scheduled_queue_item:<reason>`; all five holds listed |
| Branch leaves work | #400007 leased, #400008 pending | as left |
| origin/main reopens | raw rows before and after the first read; `/stats` and public `GET /api/exact-review-queue` | byte-identical; stats count both reasons; public route 200, collection `complete`, holds folded into `unknown: 5` |
| origin/main finishes branch work | completes the #400007 lease | completed |
| Retained holds, scheduled offers | a scheduled offer per held item | every offer `deduped:scheduled_queue_item:item_already_pending_or_active`; no run |
| Retained hold, automatic recovery | `failed_review_shard_recovery` for #40088 | answered `queued`, but the row stays parked and nothing dispatches |
| Releases on origin/main | `issues/unlocked` for #56312, `synchronize` to a new head for #119055, `re_review` command for #38283 | each `queued` and pending; all three plus #400008 dispatched, #119055 on the new head |
| End state | remaining rows | #40088 and #119056 still held, #400003 still `scanner_refused`, #38283 dispatching; nothing lost |

All 16 assertions pass. One rollback-window limit is recorded rather than
hidden: a byte-identical retry of a branch-era scheduled delivery whose stored
disposition names a hold reason is answered by origin/main as an unscoped
`deduped` (it cannot parse the new reason), so a scheduled producer retrying
that exact delivery across the rollback would report an ambiguous dedupe for
that one offer. The source-drift loop breaker's `source_drift_loop` reason has
the same property. Reproduce with:

```sh
node docs/proof/review-noop-holds/upgrade-and-rollback.mjs origin/main ~/.cache/clawsweeper-proof-tools .artifacts/review-noop-holds-upgrade
```

- base `dd58d9ec74fbfa5f757caab1b24c07194bef6f2b`, head
  `56214cc1928851cf8f1fc3501a375cc2d38c1045`, `working_tree_dirty: false`
- [`upgrade-and-rollback.json`](upgrade-and-rollback.json) SHA-256:
  `669a2e5bb39dc6a8e8f95c3f3d7b1b9fd63a6e93b00e9a5551c4d2c114be0e38`
  (copied byte-for-byte from the run output)
- `upgrade-and-rollback.mjs` SHA-256:
  `91e19b3633743e55306dce9e97a7b7ca92690414799a120480040c41d5a08d9e`
- baseline and candidate source hashes are listed in the receipt

Limits: one Durable Object persisted by Miniflare on local disk, not a
production Cloudflare deployment; synthetic GitHub fixture; completions carry
the updated sweep.yml payload instead of running Actions; review execution is
replaced by claim plus completion; alarms only by explicit fake-clock ticks.

## OpenClaw Bay

Bay needs no UI change. A held row is a completed review, so the read-model Bay
projection skips it the same way it skips a `scanner_refused` hold and leaves
the item's terminal lifecycle card in place; without that skip the held row
would surface as active `repairing` work (covered by
`test/exact-review-review-hold.test.ts`). The two new parked reasons are counts
on the existing observer-only queue projection; Bay adds no control.
