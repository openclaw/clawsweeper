# Operator canonical-record read authentication proof

Production exact-review reconcile run `31651591787` at `2026-08-12T23:38Z` checked ten head-mismatch targets and received `401` from every canonical completed-review lookup. The operator signed the existing read-only record GET with `EXACT_REVIEW_OPERATOR_SECRET`, while the Worker accepted only `CLAWSWEEPER_WEBHOOK_SECRET`. The shared-secret test setup for [openclaw/clawsweeper#1148](https://github.com/openclaw/clawsweeper/pull/1148) hid that boundary mismatch.

The fix keeps the route and signature shape unchanged. `GET /internal/state/records/<repo-slug>/(items|closed|plans|decision-packets)/<number>` verifies the webhook secret first and, only if that fails, verifies the operator secret. A missing configuration returns 503 only when neither secret exists. Accepting the operator credential on this read-only route is not a privilege escalation because it already authorizes the queue’s mutation endpoints. The operator script and workflows remain unchanged.

The executable [behavior contract](behavior-contract.md) and [RED/GREEN record](red-green.md) close the shared-secret coverage gap. `run-proof.mjs` extracts the merge base, boots it with distinct secrets, publishes a synthetic record, and proves operator/webhook/garbage statuses of 401/200/401. It then kills the complete Wrangler process tree, confirms the health endpoint is down, boots the candidate on the same port with separate persistence, and proves 200/200/401. The router-level unit test independently covers the same candidate auth matrix plus missing configuration.

Run the real-Worker comparison from a committed head with:

```bash
node docs/proof/operator-record-read-auth/run-proof.mjs "$(git rev-parse HEAD)"
```

The final Docker-backed Crabbox `local-container` receipt, captured transcript, behavior report, content hashes, and cleanup result are recorded beside this file after the implementation commit is frozen.

OpenClaw Bay is unaffected: no queue lifecycle, telemetry, dashboard data contract, or observer/action boundary changes. The operational-cursor route is also unchanged because its only current consumer uses the webhook secret.
