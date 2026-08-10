# Parked review reconciliation proof

## Claim

The real local dashboard Worker and `ExactReviewQueue` Durable Object expose a bounded, signed
inventory for parked reviews. After the existing automatic recovery budget is genuinely exhausted,
the parked-review operator resolves a terminal target and re-enqueues an open target as a fresh
pending review with a reset recovery budget.

## Exercised surface

- Real `wrangler dev --local` Worker and Durable Object with disposable persistence
- Signed exact-review enqueue and parked-review operator routes
- The unchanged three-rung parked recovery alarm path (5/10/20 minutes, persisted 0.75-1.5x jitter)
- Built `scripts/exact-review-dead-letter-operator.mjs --action reconcile-parked --execute`
- A loopback GitHub stub for App installation tokens, live issue state, workflow state, and
  repository-dispatch rejection
- Full Wrangler process-tree stops, restart from the same Durable Object persistence, and a
  read-only DO schema-instantiation assertion

## Controlled scenario

Two synthetic open issues are enqueued through the signed Worker route. The loopback GitHub stub
returns the single-field HTTP 422 validation response that the production dispatcher classifies as
`permanent_rejection`, parking each item as `dispatch_rejected`. Wrangler alarms perform all three
automatic recoveries; every recovered item reaches the same real dispatch path and parks again.
The proof waits until both inventory rows report `parked_recovery_attempts: 3`.

The Worker process tree is then stopped. The proof opens Wrangler's disposable SQLite database only
to assert that the `exact_review_queue_parked_actions` table was instantiated; it never inserts,
updates, or deletes queue state. The Worker restarts against the same persistence with its normal
90-second enqueue debounce. The stub marks one target closed and accepts dispatches. The real
operator classifies the targets, resolves the closed row with an audit note, fresh-recovers the open
row, and the proof observes that row as `pending` with `parked_recovery_attempts: 0`.

## Command and timing

Run from the repository root on Node 24 or newer with Docker/OrbStack available:

```bash
bash docs/proof/parked-review-reconcile/run-proof.sh
```

The recovery ladder is deliberately not shortened or faked. Its persisted jitter makes exhaustion
take 26.25-52.5 minutes; the script has a 60-minute hard deadline. Generated evidence is written to
`docs/proof/parked-review-reconcile/artifacts/` unless
`PARKED_REVIEW_RECONCILE_PROOF_OUTPUT` overrides it.

## Required observations

- The Durable Object is instantiated and the parked action-receipt table exists.
- Both rows are visible through the signed list route after exactly three automatic recoveries.
- The operator inspects two targets, resolves one terminal target, and recovers one open target.
- The terminal target has no queue item after reconciliation.
- The open target is pending with attempts and parked recovery attempts reset to zero.
- The final parked inventory is empty.

## Limits and Bay impact

The GitHub service is a loopback behavioral stub; no production GitHub repository, Worker, secret,
comment, or workflow is contacted or mutated. The proof covers the real Worker/DO state machine,
HTTP signing, alarms, operator process, and persistence boundary, not GitHub's hosted implementation.
OpenClaw Bay is unaffected: it remains a public observer-only surface and gains no recovery, DLQ,
queue, workflow, deploy, or rollback action.
