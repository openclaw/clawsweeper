# Retained stale-revision publication hold

Status: historical proof for reporting retained stale-revision publication rows as parked. The owning code is `computeStatsBody` in `dashboard/exact-review-queue.ts`, the lane read model in `dashboard/exact-review-read-model.ts` and publication health in `dashboard/exact-review-health.ts`. Retention, claim and cleanup behavior are unchanged.

## Claim and exercised surface

A superseded command publication whose successor witness is missing (the #1396 production fingerprint) stays retained and unclaimable by design. Before this change it was counted as `ready`: it pinned `oldest_ready_at` and escalated health on its pending age. After this change the same row counts as parked with reason `stale_revision`, and health escalates on the hold age instead (`stale_revision_over_1h` degraded, `stale_revision_over_6h` critical).

The proof drives the real `ExactReviewQueue` Durable Object in workerd with SQLite: `/enqueue`, `/publication-batches/claim`, `/publication-batches/complete`, `/publication-batch-results`, `/lifecycle/router-receipt`, `alarm()`, `/stats`, and `publicExactReviewQueueProjection`. A synthetic clock starts at 2030-01-01, and outbound network is blocked.

Scenario:

1. A batch claims command row A (revision 1).
2. Row B (revision 2) is admitted.
3. A's successor witness is removed, to model a row admitted before #1475.
4. B publishes and completes, then A's batch lease expires.
5. The queue is observed at 90 minutes, 24 hours and 40 days.
6. Control: an unrelated fresh publication is claimed through the same route.
7. A parked `dead_letter_capacity` row is injected.
8. A newer revision for A's item is admitted.

## Command

```sh
node docs/proof/stale-revision-hold/run-proof.mjs before <clean-checkout-at-base> <tools-dir> before.json
node docs/proof/stale-revision-hold/run-proof.mjs after <clean-checkout-at-head> <tools-dir> after.json
```

`<tools-dir>` is a directory containing `wrangler@4.107.0` installed with `--ignore-scripts`, which provides workerd 1.20260701.1 and Miniflare 4.20260701.0. Both runs used Node v24.21.0.

| Receipt | Head | Clean tree | Outbound requests | SHA-256 |
| --- | --- | --- | --- | --- |
| `before.json` | `0f5162431a344474998f10042f3ea0f8a5705e2a` (base) | yes | 0 | `422d0c6b5925b9530244ea0e7b53d7611f201393deb5ab623ae5749764e283f7` |
| `after.json` | `8390de4435` (runtime identical to `59a8de31a1`) | yes | 0 | `6f1255bb9d992ef51b89e5436ceb3cca2e9bb3818e773eb81ca592232fe7fd4b` |

Harness `run-proof.mjs` SHA-256: `a4dbcbd7ea5db9f146b378a33ed5966ce53c41c692b1c721a5099f49e5426d2e`. Each receipt also records the SHA-256 of every runtime source file it bundled.

## Observed

| Phase | Base: publication lane | Head: publication lane | Held row |
| --- | --- | --- | --- |
| held 90 min | pending 1, ready 1, parked 0; pins `oldest_ready_at`; degraded `oldest_pending_over_1h` | pending 0, ready 0, parked 1 (`stale_revision`); `oldest_ready_at` null; degraded `stale_revision_over_1h` | retained, `claimed: false` on both |
| held 24 h / 40 d | ready 1, pins `oldest_ready_at`; critical `oldest_pending_over_6h` | ready 0, parked 1 (`stale_revision`); critical `stale_revision_over_6h` | retained, `claimed: false` on both |
| plus dead letter | parked 1 (`dead_letter_capacity`); critical `dead_letter_capacity` | parked 2 (`stale_revision`, `dead_letter_capacity`); critical `dead_letter_capacity` | retained on both |
| newer revision | held row superseded and removed | held row superseded and removed; `stale_revision` gone | removed on both |

The control publication is claimed alone on both builds, without the held row. The public projection stays `complete`.

## Limits

- The inputs and clock are synthetic. The witness loss is simulated and the dead letter is injected.
- No production state, GitHub writes or inference were involved.
- That every production row has this exact shape is inferred from the #1396 fingerprint and the public lane counts, not confirmed row by row.
