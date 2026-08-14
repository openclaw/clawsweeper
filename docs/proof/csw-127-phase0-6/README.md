# CSW-127 Phase 0.6 proof receipt

The product-and-proof commit rebased onto merged PR #1169,
`92d91e812f810c5bf9f7e0f470cb017533aee43c`
(tree `84f9205a89d0fafdd20e9796affb7b67bd534fe2`), passed the production-shaped
boundary proof defined in [behavior-contract.md](behavior-contract.md).

## Environment

- Provider: Crabbox `local-container`, lease `cbx_b188010777d1` (`swift-krill-16ae`)
- Image: `node:24-bookworm`
- Runtime boundary: `wrangler@4.107.0 --local` plus the real SQLite-backed
  `ExactReviewQueue` Durable Object
- Result: exit `0`; lease stopped; 272,317 ms total
- Source identity: the container reconstructed the immutable `git archive` and
  asserted tree `84f9205a89d0fafdd20e9796affb7b67bd534fe2` before running proof

The proof used [run-crabbox-bind.sh](run-crabbox-bind.sh) as the local-container
entry point and [run-proof.sh](run-proof.sh) as the in-container harness. The
explicit read-only source bind was used after the normal Windows rsync transport
failed before transferring the checkout. `jq` was installed only inside the
disposable proof container because the selected Node image does not include it.

## Observed result

- All 235 focused telemetry, queue, batch-publication, and batch-CLI tests passed.
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
- Fallback `complete` and `release` paths preserved a `target_app` circuit as
  `pool_class=target_app` rather than falling back to `repository_actions`.
- The full Linux `pnpm run check` gate passed. Coverage was 81.49% lines, 74.08%
  branches, and 87.35% functions.

## Rebased contract reconciliation

The proved Phase 0.6 branch was rebased once more onto `main` at
`6494ab5eb285cc2993d4679d6723e4b2486de99c`. The combined tree preserves the
landed [R2 artifact receipt store](https://github.com/openclaw/clawsweeper/pull/1163),
the [ETag broker](https://github.com/openclaw/clawsweeper/pull/1164) and its
`broker_lookup` and `conditional_response` telemetry units, the
[webhook materialized read model](https://github.com/openclaw/clawsweeper/pull/1167),
the [restored throttled-publication retry classification](https://github.com/openclaw/clawsweeper/pull/1168),
and [PR #1169's bounded per-run operational-health confirmation](https://github.com/openclaw/clawsweeper/pull/1169).
Phase 0.6 adds independent eviction watermarks and bounded
publication-transition cause buckets; it does not duplicate or replace those
contracts. PR #1169's webhook run-confirmation, exact-recheck, unknown-health,
and phantom-run eviction semantics remain unchanged; the two changes add
separate sections to `docs/live-dashboard.md`.

The first rebased local ClawSweeper range review found one P2 observer-only
defect: terminal batch outcomes advanced the attempt bucket after an earlier
failure. The rebased fix commit `3f3793dfff6a959a36cc3767101d902d7ff6e154` aligned the batch path
with direct completion and added the retry-then-publish regression above.

The committed Codex review then found one P2 owner-isolation defect in fallback
rate-limit completions. Commit `92d91e812f810c5bf9f7e0f470cb017533aee43c`
carries the active circuit scope through both batch `complete` and `release` and
adds regressions for the `target_app` path. The complete proof above was rerun
after this fix.

Two discarded Docker leases stopped before test execution. Lease
`cbx_42cd4a3fdb12` rejected the CRLF-mounted wrapper, and lease
`cbx_35f8c4b178f6` rejected ignored-file contamination through the worktree
bind. The successful run used the harness's immutable `git archive` input and
the same expected Git tree.

Machine-readable results and artifact digests are recorded in
[container-receipt.json](container-receipt.json). Raw local artifacts are not
committed because they contain synthetic fixture detail and do not improve the
reviewable proof boundary.

## Limits

This was a local, production-shaped boundary test with synthetic fixtures. It
did not touch production, GitHub, workflows, queues, DLQs, gates, schedules,
capacity, deployments, or credentials. It does not activate Phase 1. The
owner-isolated `target_app` closure-proof 403 remains separate. The post-merge
production cohort is authorized as read-only observation; Phase 1 activation
still requires a separate explicit decision even if that cohort passes.
