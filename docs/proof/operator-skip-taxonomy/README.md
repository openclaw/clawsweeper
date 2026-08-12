# Dead-letter operator skip-taxonomy proof

Production reconcile run 31646150689 at 2026-08-12T22:15Z reported `inspected_targets=3`, `recovered_targets=0`, and `skipped_targets=125`, but `skip_reasons={}`. With 191 open rows still in the dead-letter tail, the operator could not distinguish stale pull-request heads from active work, ineligible rows, caps, inventory safety exits, or other conservative skips.

This change makes the existing accounting honest without changing reconciliation decisions. Each deterministic skip branch records a stable class at the point where it already increments the target count. GitHub and transport failures retain the existing shared classifier. Revalidation aborts split the bulk count across the target that changed, targets already inspected, and targets not reached, so the summary remains exact instead of attributing unrelated targets to the triggering condition.

The runtime now emits a non-throwing `reconcile_skip_accounting_inconsistent` marker if the reason-count sum ever differs from `skipped_targets`. The loopback harness checks that marker across every successful reconcile scenario, while the mixed invariant fixture directly asserts four reason counts for four skipped targets.

The behavior contract is in `behavior-contract.md`; the red/green record is in `red-green.md`. The final Docker-backed Crabbox lease, content hashes, transcript scan, and cleanup state are recorded in `receipt.json` after execution.

OpenClaw Bay needs no change: it already consumes the dynamic observer-only `skip_reasons` map, and this work adds neither a new transport shape nor an action surface.
