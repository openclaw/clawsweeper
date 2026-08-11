# Parked review reconciliation proof

## Claim

The real local dashboard Worker and `ExactReviewQueue` Durable Object expose a bounded, signed
inventory for parked reviews. After the existing automatic recovery budget is genuinely exhausted,
the parked-review operator resolves a terminal target and re-enqueues an open target as a fresh
pending review with a reset recovery budget, while leaving a command-context target parked for its
maintainer-command obligations.

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

Two ordinary open issues and one command-context review are enqueued through the signed Worker
route. The command uses the real legacy command intake shape: a pull-request item with
`sourceAction: "legacy_dispatch"`, command status marker, status comment id, and additional prompt.
`exactReviewQueueHasCommandContext` recognizes that stored decision. The loopback GitHub stub
returns the single-field HTTP 422 validation response that the production dispatcher classifies as
`permanent_rejection`, parking each item as `dispatch_rejected`. Wrangler alarms perform all three
automatic recoveries; every recovered item reaches the same real dispatch path and parks again.
The proof waits until all three inventory rows report `parked_recovery_attempts: 3` and the command
row reports `excluded_reason: "command_context"`.

The Worker process tree is then stopped. The proof opens Wrangler's disposable SQLite database only
to assert that the `exact_review_queue_parked_actions` table was instantiated; it never inserts,
updates, or deletes queue state. The Worker restarts against the same persistence with its normal
90-second enqueue debounce. The stub marks the ordinary terminal target and the command-context
target closed, then accepts dispatches. The real
operator classifies the targets, resolves the closed row with an audit note, fresh-recovers the open
ordinary row, and skips the command-context row before GitHub inspection. Direct signed resolve and
recover requests for that command row both report one skipped mutation. The proof observes the
ordinary recovered row as `pending` with `parked_recovery_attempts: 0` and the command-context row
unchanged as `parked` with `parked_recovery_attempts: 3`.

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
- All three rows are visible through the signed list route after exactly three automatic recoveries.
- The command-context row is flagged with `excluded_reason: "command_context"`.
- The operator inspects two targets, resolves one terminal target, and recovers one open target.
- The operator counts the excluded command-context target as skipped without inspecting it.
- Signed resolve and fresh-recover requests both refuse the command-context row.
- The terminal target has no queue item after reconciliation.
- The open target is pending with attempts and parked recovery attempts reset to zero.
- The final parked inventory contains only the unchanged command-context target.

## Limits and Bay impact

The GitHub service is a loopback behavioral stub; no production GitHub repository, Worker, secret,
comment, or workflow is contacted or mutated. The proof covers the real Worker/DO state machine,
HTTP signing, alarms, operator process, and persistence boundary, not GitHub's hosted implementation.
It exercises the initial command-review dispatch-rejection route. Terminal-finalization command
acknowledgements use their separate pending retry path and are intentionally outside this parking
scenario.
OpenClaw Bay is unaffected: it remains a public observer-only surface and gains no recovery, DLQ,
queue, workflow, deploy, or rollback action.
