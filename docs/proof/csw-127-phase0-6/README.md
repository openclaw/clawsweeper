# CSW-127 Phase 0.6 proof receipt

The exact product-and-proof commit `1e6ee58bb26736369dd099476079bf5021049264`
(tree `3bdf1ce609f2b07a900305817892ef3cd15c2d3c`) passed the production-shaped
boundary proof defined in [behavior-contract.md](behavior-contract.md).

## Environment

- Provider: Crabbox `local-container`, lease `cbx_fb4fccfeaaef` (`quick-prawn`)
- Image: `node:24-bookworm`
- Runtime boundary: `wrangler@4.107.0 --local` plus the real SQLite-backed
  `ExactReviewQueue` Durable Object
- Result: exit `0`; lease stopped; 297,406 ms total
- Source identity: the container reconstructed the immutable `git archive` and
  asserted tree `3bdf1ce609f2b07a900305817892ef3cd15c2d3c` before running proof

The proof used [run-crabbox-bind.sh](run-crabbox-bind.sh) as the local-container
entry point and [run-proof.sh](run-proof.sh) as the in-container harness. The
explicit read-only source bind was used after the normal Windows rsync transport
failed before transferring the checkout. `jq` was installed only inside the
disposable proof container because the selected Node image does not include it.

## Observed result

- All 232 focused telemetry, queue, batch-publication, and batch-CLI tests passed.
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
- Public output passed the privacy assertions. A follow-up scan of the bounded
  receipts and redacted Worker log found no token, authorization header, private
  key, database URL, API-key, or token-assignment patterns.
- The full Linux `pnpm run check` gate passed. Coverage was 81.49% lines, 73.97%
  branches, and 87.30% functions.

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
