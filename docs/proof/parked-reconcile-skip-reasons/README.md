# Parked reconciliation skip-reason proof

## Claim

Parked-review reconciliation now reports bounded, sanitized, per-target inspection-failure reason
classes and samples. The 20 skipped rows in scheduled production run
https://github.com/openclaw/clawsweeper/actions/runs/31449984643 were caused by the workflow GitHub
token's target-read boundary: replaying that run's immutable 20-row inventory through the unchanged
read-only operator with Peter's personal `gh` token classified every target.

The after-fix trace also proves the error path through a real loopback HTTP listener: 20 issue-read
403s produce exactly 20 `http_403` skips, while a mixed run with two open targets produces exactly 18
`http_403` skips and preserves the two successful targets.

## Exercised surface

- Production artifact `exact-review-dlq-reconcile-31449984643-1` (artifact id `9085971968`)
- Built `scripts/exact-review-dead-letter-operator.mjs --action reconcile-parked` without `--execute`
- Peter's personal GitHub token from `gh auth token`
- The live public queue-pressure payload (`idle`, capacity 128, active 7)
- Node 24.19.0 and pnpm 11.10.0 on macOS

The production environment-scoped `EXACT_REVIEW_OPERATOR_SECRET` is intentionally non-retrievable.
The signed inventory request was therefore replayed over loopback from the immutable production
artifact. Null `excluded_reason` fields added by artifact sanitization were omitted to restore the
signed list route's wire shape. GitHub target inspection and classification remained live and used
the personal token. No queue mutation route was available from the loopback replay, and the operator
was not passed `--execute`.

## Diagnosis record: base-SHA replay

This section is the original diagnosis record, not the after-fix error-path proof. Its replay used
base SHA `c145b4599285969b43e40d0816071893d5090501`; full provenance remains in
`production-provenance.json`.

The scheduled workflow-token run emitted:

```json
{"action":"reconcile-parked","dry_run":false,"inventory_complete":true,"queue_pressure":"idle","inspected_targets":20,"terminal_targets":0,"repository_gone_targets":0,"resolved_targets":0,"open_targets":0,"recovered_targets":0,"skipped_targets":20}
```

The personal-token read-only replay emitted the exact contents of `read-only-summary.json`: all 20
targets were inspected, 1 was terminal, 19 were open, 5 fit the bounded recovery preview, and the
remaining 14 were skipped only by the recovery budget. There were no inspection failures, so
`skip_reasons` is empty.

## After-fix error-path trace

`run-error-trace.mjs` read the same immutable artifact (SHA-256
`1187c6042803b5ba98048d64157cb98a5399c1cbde76b69ce25f18dffe23b88f`), bound a real Node HTTP
listener to `127.0.0.1` on an ephemeral port, and launched the current source-tree operator as a
separate process with `GITHUB_API_URL` pointing at that listener. Both runs omitted `--execute`,
unset `GITHUB_TOKEN`, exposed no mutation route, and recorded only redacted request metadata.

All 20 issue lookups returned 403. `all-403-summary.json` contains this verbatim summary:

```json
{"action":"reconcile-parked","dry_run":true,"inventory_complete":true,"queue_pressure":"idle","inspected_targets":20,"terminal_targets":0,"repository_gone_targets":0,"resolved_targets":0,"open_targets":0,"recovered_targets":0,"skipped_targets":20,"skip_reasons":{"http_403":20},"skip_samples":[{"target":"steipete/codexbar#2367","reason":"parked review target check failed for steipete/codexbar#2367 with 403"},{"target":"steipete/codexbar#2407","reason":"parked review target check failed for steipete/codexbar#2407 with 403"},{"target":"steipete/codexbar#2469","reason":"parked review target check failed for steipete/codexbar#2469 with 403"}]}
```

The mixed scenario returned 200-open for the first two targets and 403 for the remaining 18.
Because the dry-run recovery preview rechecks open targets, the socket trace contains four 200 issue
responses for two unique targets. `mixed-summary.json` contains this verbatim summary:

```json
{"action":"reconcile-parked","dry_run":true,"inventory_complete":true,"queue_pressure":"idle","inspected_targets":20,"terminal_targets":0,"repository_gone_targets":0,"resolved_targets":0,"open_targets":2,"recovered_targets":2,"skipped_targets":18,"skip_reasons":{"http_403":18},"skip_samples":[{"target":"steipete/codexbar#2469","reason":"parked review target check failed for steipete/codexbar#2469 with 403"},{"target":"steipete/codexbar#2471","reason":"parked review target check failed for steipete/codexbar#2471 with 403"},{"target":"steipete/codexbar#2473","reason":"parked review target check failed for steipete/codexbar#2473 with 403"}]}
```

`after-fix-error-trace.jsonl` records the 46 loopback requests and response statuses.
`after-fix-error-trace-provenance.json` records the artifact identity, exact operator content hash,
command, transport, response mix, and proof limits.

## Gates

- `pnpm run build:all`: passed
- `pnpm run test:no-build`: 3,318 tests; 3,309 passed, 9 skipped, 0 failed
- `pnpm run lint`: passed
- `pnpm run format:check`: passed
- `pnpm run check:active-surface`: passed

Fresh-PR container proof used Crabbox `provider=aws`, lease `cbx_0fc9d2f49c92`
(`pearl-prawn-4739`), and run `run_2f53d8d972e6`. The clean PR 1117 checkout at
`8dd3a55bb774ec30fdc5a39fbf7957f53810863f` ran inside `node:24-bookworm` on Docker 29.7.1.
Corepack installed pinned pnpm 11.10.0. jq 1.8.1 was installed under `$HOME/.local/bin` only after
`jq-linux-amd64` verified against the official release checksum
`020468de7539ce70ef1bceaf7cde2e8c4f2ca6c3afb84642aabc5c97d9fc2a0d`. All 57 focused operator
tests passed in 11.2 seconds for that diagnosis-round head; Crabbox reported exit 0 and stopped the
lease automatically. Full machine-readable details are in `container-provenance.json`. The final
after-fix head receives a separate fresh-PR container run after push.

## Limits and Bay impact

This production observation proves the token-boundary diagnosis and the successful-target summary.
The focused operator tests cover per-target standard-reconcile discovery and recovery-revalidation
attribution, reason classification, bounded samples, credential and control-byte sanitization, and
output truncation. The replay did not mutate production queue state and cannot prove the production
Worker's signed list route beyond the immutable uploaded artifact.

OpenClaw Bay is unaffected. The change adds diagnostic fields to an operator-only JSON summary; it
does not change lifecycle publication, dashboard data, or the observer-only Bay surface.
