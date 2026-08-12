# Operator canonical-record read authentication proof

Production exact-review reconcile run `31651591787` at `2026-08-12T23:38Z` checked ten head-mismatch targets and received `401` from every canonical completed-review lookup. The operator signed the existing read-only record GET with `EXACT_REVIEW_OPERATOR_SECRET`, while the Worker accepted only `CLAWSWEEPER_WEBHOOK_SECRET`. The shared-secret test setup for [openclaw/clawsweeper#1148](https://github.com/openclaw/clawsweeper/pull/1148) hid that boundary mismatch.

The fix keeps the route and signature shape unchanged. `GET /internal/state/records/<repo-slug>/(items|closed|plans|decision-packets)/<number>` verifies the webhook secret first and, only if that fails, verifies the operator secret. A missing configuration returns 503 only when neither secret exists. Accepting the operator credential on this read-only route is not a privilege escalation because it already authorizes the queue’s mutation endpoints. The operator script and workflows remain unchanged.

The executable [behavior contract](behavior-contract.md) and [RED/GREEN record](red-green.md) close the shared-secret coverage gap. `run-proof.mjs` extracts the merge base, boots it with distinct secrets, publishes a synthetic record, and proves operator/webhook/garbage statuses of 401/200/401. It then kills the complete Wrangler process tree, confirms the health endpoint is down, boots the candidate on the same port with separate persistence, and proves 200/200/401. The router-level unit test independently covers the same candidate auth matrix plus missing configuration.

Run the real-Worker comparison from a committed head with:

```bash
node docs/proof/operator-record-read-auth/run-proof.mjs \
  "$(git rev-parse HEAD)" \
  "$(git merge-base HEAD origin/main)"
```

Docker-backed Crabbox `provider=local-container` ran the frozen executable head `c2c81fcdb6861a1b15ae9f9b6531d76c776d433b` in `node:24-bookworm` on lease `cbx_c96e9586c6f8` (`quick-shrimp-ead6`). The router test passed, the real Worker produced the required 401→200 operator transition with webhook 200 and garbage 401, both process trees stopped cleanly, `check:dashboard-strict` passed without adding `worker.ts`, and the full gate passed 3,393 of 3,401 tests with eight platform skips and zero failures. Crabbox exited 0 and stopped the lease automatically. The frozen [behavior report](behavior-report.json), [receipt](receipt.json), captured transcript, and stderr are recorded beside this file.

OpenClaw Bay is unaffected: no queue lifecycle, telemetry, dashboard data contract, or observer/action boundary changes. The operational-cursor route is also unchanged because its only current consumer uses the webhook secret.
