# Lost lease-completion callback proof

These two drivers reproduce https://github.com/openclaw/clawsweeper/issues/1245 and show the
corrected behavior.

## Owed source-drift requeue survives a lost completion callback

`run-proof.sh` starts the actual local Wrangler Worker and its `ExactReviewQueue` Durable Object,
then drives the real signed ingress routes across the real Workers Durable Object boundary. A
proof-only entry module re-exports the production `ExactReviewQueue` and adds two markers that are
read from the body of the already-forwarded `/internal/exact-review/publications/list` route: one
seeds a leased item through the production state writer the way a dispatcher would have, the other
reads the durable item, its lifecycle projection, and the Bay telemetry tables back out. Every
queue, route, signature, lifecycle-projection, reducer, and SQLite storage path stays real.

Three scenarios run against a direct publication receipt whose lifecycle plan is
`{ kind: "requeue" }`:

- `completion-delivered` posts the real `/internal/exact-review/complete` callback carrying
  `direct_lifecycle_requeue: true`, the control that shows the owed follow-up review being created;
- `completion-unreachable-green-run` drops that callback the way a queue outage does and instead
  posts the signed `/internal/exact-review/reconcile` payload that
  `.github/workflows/exact-review-reconcile.yml` sends for a green run;
- `completion-unreachable-superseded-receipt` first publishes revision 5 on the same fence so the
  run's own revision-4 receipt comes back `superseded` while still carrying the stored `requeue`
  plan, then drops the callback the same way. This is the control for the case the normal completion
  path settles as superseded: `sweep.yml` leaves `direct_lifecycle_requeue` false whenever
  `DIRECT_PUBLICATION_SUPERSEDED` is true, and the publication lane's own direct-lifecycle recovery
  step short-circuits on `receipt_outcome = superseded` before it dispatches on the plan kind.

The script detects whether the checked-out tree contains the fix and asserts accordingly. Before the
fix the second scenario reports `requeued: 0, completed: 1` and the item is deleted. After the fix it
reports `requeued: 1, completed: 0` and leaves the same fresh `source_drift_requeue` revision the
delivered callback produces. The first and third scenarios are identical either way: the superseded
receipt completes with `requeued: 0, completed: 1` and keeps its `superseded` terminal disposition,
because the recovery predicate requires an `accepted` or `deduped` receipt outcome.

Run from the repository root of the tree under test:

```bash
crabbox run \
  --provider local-container \
  --local-container-image node:24-bookworm \
  --no-hydrate \
  --timing-json \
  --script docs/proof/exact-review-completion-metadata/run-proof.sh \
  --require-artifact '.artifacts/exact-review-completion-metadata/proof-summary.json' \
  --artifact-glob '.artifacts/exact-review-completion-metadata/**'
```

Bay: every scenario also captures the Bay telemetry tables and the public
`GET /api/durable-lifecycle-bay` snapshot on either side of the recovery. A `requeue` terminal
disposition is not a Bay outcome, so `bayLifecycleEvent` returns null for it and no Bay event,
pending, or tide-buffer row is written. The snapshot is byte-identical before and after, on both the
healed and the delivered path.

Limits: no live Cloudflare edge and no live sweep run are driven. The initial leased item is seeded
through the production state writer rather than by a real GitHub dispatch, because the dispatcher
requires the GitHub API. The reconciler's GitHub run lookup is not exercised; the `terminal_runs`
payload the scheduled reconcile lane posts is used directly.

## Fail gate names the trigger that actually fired

```bash
node docs/proof/exact-review-completion-metadata/annotation-proof.mjs
```

`annotation-proof.mjs` parses the real `.github/workflows/sweep.yml`, evaluates the
`Fail unsuccessful exact review generation` step's own `if:` expression against three scenarios,
resolves that step's `env:` templates from the same step results, and executes its `run:` block
verbatim under bash. It prints the annotation the operator would actually see.

Before the fix all three scenarios print `classification=codex_or_content_failure`, including the
two whose review lane succeeded or was skipped. After the fix the two completion-failure scenarios
print `classification=queue_completion_failure` while the genuine review-lane failure keeps
`classification=codex_or_content_failure`.

To capture the before half of either driver, revert the corresponding production file to `main`
(`git checkout origin/main -- dashboard/exact-review-queue.ts` or
`git checkout origin/main -- .github/workflows/sweep.yml`), run the driver, then restore the patch.

Neither driver mutates production, deploys anything, or contacts GitHub.
