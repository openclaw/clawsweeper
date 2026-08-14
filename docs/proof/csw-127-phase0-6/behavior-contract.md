# CSW-127 Phase 0.6 real behavior proof contract

## Scope and authority

- Base: `openclaw/clawsweeper` `main` at `e17e09425b604aeb6db9fb56494f640a9454ec97`.
- Branch: `codex/csw-127-phase0-6`.
- Effective runtime: `danger-full-access`, approval `never`, network enabled.
- Authorized output: an exact-head draft PR only. No merge, deployment, workflow dispatch,
  queue/DLQ mutation, capacity/schedule/admission change, gate change, or Phase 1 activation.
- PR #1145 remains independent and untouched; Phase 1 stays default-disabled.

## Evidence-driven claims

1. A row-cap eviction records the greatest timestamp actually evicted, not the time at which
   eviction ran. A 15-minute or one-hour query is complete when every evicted rollup/rate-limit
   row is older than that query window, even if an old-row cap eviction happened recently.
2. Legacy diagnostics that cannot prove which timestamps were evicted fail closed. Missing,
   late, truncated, or genuinely evicted in-window evidence must never be represented as
   complete, and observed conservation totals must never be fabricated.
3. Publication retry, backoff, supersession, refresh, and retry-exhausted/DLQ transitions are
   durably reconciled in bounded five-minute cause buckets. Public rows use only closed,
   privacy-safe dimensions: transition, completion stage/kind/reason, revision relation,
   credential pool, recovery cause, backoff class, and attempt bucket. They expose no target,
   item, credential, run, artifact, lease, or error fingerprint.
4. A replayed completion cannot double-count transition telemetry. Restart, deduplication,
   retention, and cardinality caps preserve the same queue transition and public summary.
5. Existing reset-plus-jitter admission behavior, command resumption, typed exits, pool owner
   isolation, v1/v2 compatibility, Bay/status semantics, and rollback behavior are unchanged.
6. The Phase 0.5 sixth-recovery signal supports diagnostic attribution only. Retry limits,
   backoff delays, capacity, and scheduling remain unchanged unless deterministic proof finds a
   separate product defect.
7. The target-App closure-proof 403 path remains owner-scoped and separate from the shared
   repository-Actions circuit. It is documented as a separate follow-up unless proof shows a
   tightly coupled correctness defect.

## Deterministic proof matrix

- Reproduce the false-incomplete bug by evicting only out-of-window rollups at the row cap, then
  prove 15-minute and one-hour queries complete while an overlapping eviction remains incomplete.
- Cover old-schema restart, deduplicated receipt replay, retention boundaries, missing/late
  buckets, row truncation, rate-limit truncation, and conservation without synthesized rows.
- Drive same-revision retry/backoff, newer-revision supersession, repository-Actions throttle
  deferral, unknown-failure exhaustion into DLQ, and post-restart public cause reconciliation.
- Assert all public cause dimensions are closed and bounded and sentinel repository/item/token/
  lease/artifact/error values never appear.
- Run focused telemetry/queue/workflow tests, broad Linux gates, `git diff --check`, and
  `actionlint` if workflow YAML changes.

## Production-shaped boundary proof

Run a real Worker plus SQLite Durable Object boundary in Docker-backed Crabbox local-container.
The proof must ingest signed telemetry through the Worker route, cross a Durable Object restart,
exercise old-row and overlapping cap eviction, complete publication transitions through the
queue route, and read the public observer/status surfaces. Record exact head, provider, image,
lease/run ID, commands, redacted transcript, observed result, and limits.

## Review and delivery gates

- Dirty-patch Codex review, accepted-finding fixes, focused proof rerun, then committed-range
  Codex review against the actual base.
- Local ClawSweeper `--local-range` review from a clean committed branch.
- Open a draft PR only after exact-head proof is complete; put the Real Behavior Proof package in
  the main body, request one normal `@clawsweeper review`, and monitor CI/CodeQL.
- The draft may become ready for maintainer look, but must remain unmerged. A new stable-cohort
  post-merge monitor requires separate authorization.
