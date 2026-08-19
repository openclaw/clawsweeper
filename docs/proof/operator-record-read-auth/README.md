# Operator canonical-record read authentication proof

Production exact-review reconcile run `31651591787` at `2026-08-12T23:38Z` checked ten head-mismatch targets and received `401` from every canonical completed-review lookup. The operator signed the existing read-only record GET with `EXACT_REVIEW_OPERATOR_SECRET`, while the Worker accepted only `CLAWSWEEPER_WEBHOOK_SECRET`. The shared-secret test setup for [openclaw/clawsweeper#1148](https://github.com/openclaw/clawsweeper/pull/1148) hid that boundary mismatch.

The fix keeps the route and signature shape unchanged. `GET /internal/state/records/<repo-slug>/items/<number>` verifies the webhook secret first and, only if that fails, verifies the operator secret because reconciliation reads active items only. The `closed`, `plans`, and `decision-packets` collections remain webhook-only. Existing 503 behavior remains unchanged for missing required credentials. The operator script and workflows remain unchanged.

The executable [behavior contract](behavior-contract.md) and [RED/GREEN record](red-green.md) close the shared-secret coverage gap. `run-proof.mjs` extracts the merge base, boots it with distinct secrets, publishes all four synthetic records, and proves the full operator/webhook/garbage matrix. It then kills the complete Wrangler process tree, confirms the health endpoint is down, and boots the candidate on the same port with separate persistence. The router-level unit test independently covers the same candidate matrix plus missing configuration.

Run the real-Worker comparison from a committed head with:

```bash
node docs/proof/operator-record-read-auth/run-proof.mjs \
  "$(git rev-parse HEAD)" \
  "$(git merge-base HEAD origin/main)"
```

The final Docker-backed Crabbox `provider=local-container` receipt, tested executable head, lease, full matrix, and gate totals are frozen in [receipt.json](receipt.json). The [behavior report](behavior-report.json), captured transcript, and stderr are recorded beside it.

OpenClaw Bay is unaffected: no queue lifecycle, telemetry, dashboard data contract, or observer/action boundary changes. The operational-cursor route is also unchanged because its only current consumer uses the webhook secret.
