# Dead-letter operator skip-taxonomy behavior contract

## Claim

The exact-review dead-letter operator's `reconcile` summary classifies every target counted in `skipped_targets`. The sum of all `skip_reasons` counts equals `skipped_targets`, including mixed cycles and bulk skip-all exits. Existing error-derived classes such as `github_throttled`, `http_403`, `timeout`, and `installation_missing` retain their current meanings.

Deterministic skip decisions use stable, snake-case, low-cardinality classes. Samples use the existing bounded `{ target, reason }` shape and sanitizer; no token, credential, arbitrary row data, or other PII is added. The change affects accounting only: it does not alter target selection, inspection, resolution, recovery, queue pressure, or mutation behavior.

## Exercised surface

- `scripts/exact-review-dead-letter-operator.mjs` through its real CLI process boundary.
- Real loopback HTTP endpoints selected through `EXACT_REVIEW_QUEUE_URL` and `GITHUB_API_URL` for queue, inventory, REST, GraphQL, resolve, and recovery traffic.
- `test/exact-review-dead-letter-operator.test.ts`, including every successful reconcile scenario's check that the runtime does not emit `reconcile_skip_accounting_inconsistent`.

## Scenarios and observable results

1. Blocked aliases, active work, ineligible rows, head mismatches, terminal-recheck and inspection caps, changed closed state, partial duplicate resolution, incomplete inventory, failed discovery, and non-actionable identities each emit their dedicated class. A mixed missing-installation plus non-actionable-identity cycle counts each target once and preserves both classes.
2. Idle queue-capacity deferral and a Worker recovery mutation skip emit `recovery_capacity` and `recovery_mutation_skipped` respectively; existing `recovery_cap` and `recovery_deferred_pressure` remain unchanged.
3. Head mismatch and no-eligible-row skips emit sanitized bounded samples in the established shape.
4. A mixed cycle combines active work, an ineligible row, a stale pull-request head, one admitted recovery, and one capacity skip. Its four reason counts sum to four skipped targets.
5. Existing GitHub throttle, HTTP, timeout, missing-installation, and abort scenarios retain their error-derived classes and bounded behavior.
6. Every successful loopback reconcile scenario is rejected by the test harness if the runtime writes the self-inconsistency marker.

## Command and environment

Run `run-proof.sh` in Docker-backed Crabbox `provider=local-container` with image `node:24-bookworm`. The script installs Corepack in the isolated container, activates the repository-pinned pnpm, installs the frozen lockfile, runs the complete dead-letter operator test file, checks formatting for every executable proof input, and records content hashes.

## Limits

GitHub and queue responses are deterministic loopback fixtures. No production credential is present, no live GitHub quota is consumed, and no production queue mutation is performed. This proves the real operator CLI's classification and accounting at its HTTP boundary, not a live production reconcile.

OpenClaw Bay is unaffected. The operator enriches the existing observer-only `skip_reasons` map without changing its transport shape or adding any queue, workflow, GitHub, recovery, deploy, or rollback control.
