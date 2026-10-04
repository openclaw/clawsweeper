# Scheduled feed observability proof

Status: historical proof that the public exact-review queue status reports the
scheduled admission budget. The owning code is `publicExactReviewQueueProjection`
and `publicExactReviewQueueLane` in `dashboard/worker.ts`; the internal values
come from `scheduledReviewFeedStatusSync` and the review shed metrics in
`dashboard/exact-review-queue.ts`, which are unchanged.

## Claim and exercised surface

Production showed scheduled backfill shed at about 72 offers per hour with
`scheduled_feed.active = 0`, but the public route did not say why. Possible causes
include organic debt, lane rates, a GitHub-throttle pause and backpressure. With
the same queue accounting on both builds, the candidate's public
`/api/exact-review-queue` additionally reports:

- the global `token_balance`, which is negative while organic debt is outstanding;
- `burst`;
- per-lane `hot_intake` and `normal_backfill` rate, burst and balance;
- `lanes.review.shed_reasons_since_reset`, split into `backpressure`,
  `scheduled_rate` and `unattributed`.

The baseline route omits all of these.

The harness bundles each build's real dashboard Worker and `ExactReviewQueue`
SQLite Durable Object and runs them in workerd. It uses a fake clock and a
loopback GitHub fixture with a synthetic RSA credential. It reads the public
route at rest, then admits 40 organic issue reviews. It alternates 15-second
clock steps, alarm ticks and claims; each claim is charged to the budget. It then
offers one `scheduled_normal_backfill` item and reads the public route again.

## Command

```sh
node docs/proof/scheduled-feed-observability/run-proof.mjs <base-ref> <tools-dir> <fresh-output-dir>
```

`<tools-dir>` contains `wrangler@4.107.0` installed with `--ignore-scripts`, which
provides workerd 1.20260701.1, Miniflare 4.20260701.0 and esbuild. The run used
Node v24.21.0.

| Field | Value |
| --- | --- |
| Base | `7f87179433d0da5a0084141a8e8d7b909988e8a4` (origin/main) |
| Head | `3601dbdd3d` (clean tree for the runtime files) |
| [`result.json`](result.json) SHA-256 | `35ce0ff12c0a23a3f8ca3ba6ce04ee5f02aa9ee23c77f76238159f1b8be1a826` |
| `run-proof.mjs` SHA-256 | `f19435ca414bbda240a761d2d01f75944cbd1fb03e71867346d1fa884f7d322b` |

The receipt records the SHA-256 of each runtime file per build, and contains no
local paths or credentials.

## Observed

| | Base | Head |
| --- | --- | --- |
| Organic reviews dispatched / claimed | 40 / 40 | 40 / 40 |
| Scheduled normal-backfill offer | shed, `scheduled_rate` | shed, `scheduled_rate` |
| Public `scheduled_feed` at rest | rate, replay, max concurrent, active | plus `burst: 24`, `token_balance: 24`, both lanes |
| Public `scheduled_feed` after the claims | rate, replay, max concurrent, active | plus `token_balance: -8`, `hot_intake.token_balance: 8`, `normal_backfill.token_balance: 16` |
| Public `lanes.review.shed_reasons_since_reset` | absent | `scheduled_rate: 1`, `backpressure: 0`, `unattributed: 0` |

All seven receipt assertions hold:

- `same_accounting`
- `scheduled_offer_shed_by_rate`
- `baseline_omits_budget`
- `candidate_at_rest_full_burst`
- `candidate_reports_organic_debt`
- `candidate_reports_lanes`
- `candidate_attributes_shed`

## Limits

- The GitHub fixture and credential are synthetic, and only issue items are used.
- A review is modeled as a claim, which is where the budget charges.
- There is no live inference, production state or GitHub mutation.
- Throttle timestamps are covered by `test/dashboard-worker-status-privacy.test.ts`,
  not by this run.
