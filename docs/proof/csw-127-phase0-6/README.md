# CSW-127 Phase 0.6 proof receipt

The rebased product-and-proof commit `3850b0819197f4a3362786235494f43339ba101a`
(tree `57592bb4ecd11fae0716503175b0dc05804626a5`) passed the production-shaped
boundary proof defined in [behavior-contract.md](behavior-contract.md).

## Environment

- Provider: Crabbox `local-container`, lease `cbx_188631fc27eb` (`quick-barnacle`)
- Image: `node:24-bookworm`
- Runtime boundary: `wrangler@4.107.0 --local` plus the real SQLite-backed
  `ExactReviewQueue` Durable Object
- Result: exit `0`; lease stopped; 303,578 ms total
- Source identity: the container reconstructed the immutable `git archive` and
  asserted tree `57592bb4ecd11fae0716503175b0dc05804626a5` before running proof

The proof used [run-crabbox-bind.sh](run-crabbox-bind.sh) as the local-container
entry point and [run-proof.sh](run-proof.sh) as the in-container harness. The
explicit read-only source bind was used after the normal Windows rsync transport
failed before transferring the checkout. `jq` was installed only inside the
disposable proof container because the selected Node image does not include it.

## Observed result

- All 233 focused telemetry, queue, batch-publication, and batch-CLI tests passed.
- The Worker accepted signed queue transitions and the SQLite Durable Object
  exposed independently reconciled, closed-dimension retry and refresh causes.
- The proof seeded the production caps of 50,000 rollup rows and 10,000
  rate-limit rows, then caused exactly two rollup evictions and one rate-limit
  eviction.
- The 15-minute and one-hour views remained honestly complete because their
  windows did not overlap the actual evicted evidence; the overlapping six-hour
  view remained incomplete.
- A real Worker restart preserved eviction watermarks plus retry- and
  refresh-cause reconciliation.
- A retryable batch completion followed by a successful completion for the same
  durable revision retained attempt bucket `1`, matching the direct-completion
  path rather than overstating the terminal transition as a second failure.
- Public output passed the privacy assertions. A follow-up scan of the bounded
  receipts and redacted Worker log found no token, authorization header, private
  key, database URL, API-key, or token-assignment patterns.
- The full Linux `pnpm run check` gate passed. Coverage was 81.48% lines, 74.11%
  branches, and 87.33% functions.

## Rebased contract reconciliation

The proved Phase 0.6 branch was rebased onto `main` at
`e17e09425b604aeb6db9fb56494f640a9454ec97`. The combined tree preserves the
landed [R2 artifact receipt store](https://github.com/openclaw/clawsweeper/pull/1163),
the [ETag broker](https://github.com/openclaw/clawsweeper/pull/1164) and its
`broker_lookup` and `conditional_response` telemetry units, the
[webhook materialized read model](https://github.com/openclaw/clawsweeper/pull/1167),
and the [restored throttled-publication retry classification](https://github.com/openclaw/clawsweeper/pull/1168).
Phase 0.6 adds independent eviction watermarks and bounded
publication-transition cause buckets; it does not duplicate or replace those
contracts.

The first rebased local ClawSweeper range review found one P2 observer-only
defect: terminal batch outcomes advanced the attempt bucket after an earlier
failure. Commit `3850b0819197f4a3362786235494f43339ba101a` aligned the batch path
with direct completion and added the retry-then-publish regression above.

Machine-readable results and artifact digests are recorded in
[container-receipt.json](container-receipt.json). Raw local artifacts are not
committed because they contain synthetic fixture detail and do not improve the
reviewable proof boundary.

## Limits

This was a local, production-shaped boundary test with synthetic fixtures. It
did not touch production, GitHub, workflows, queues, DLQs, gates, schedules,
capacity, deployments, or credentials. It does not activate Phase 1. The
owner-isolated `target_app` closure-proof 403 remains separate. A stable
post-merge production cohort still requires separate authorization before any
Phase 1 activation conclusion.
