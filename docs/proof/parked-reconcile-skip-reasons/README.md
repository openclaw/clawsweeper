# Parked reconciliation skip-reason proof

## Claim

Parked-review reconciliation now reports bounded, sanitized inspection-failure reason classes and
samples. The 20 skipped rows in scheduled production run
https://github.com/openclaw/clawsweeper/actions/runs/31449984643 were caused by the workflow GitHub
token's target-read boundary: replaying that run's immutable 20-row inventory through the unchanged
read-only operator with Peter's personal `gh` token classified every target.

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

## Controlled observation

The scheduled workflow-token run emitted:

```json
{"action":"reconcile-parked","dry_run":false,"inventory_complete":true,"queue_pressure":"idle","inspected_targets":20,"terminal_targets":0,"repository_gone_targets":0,"resolved_targets":0,"open_targets":0,"recovered_targets":0,"skipped_targets":20}
```

The personal-token read-only replay emitted the exact contents of `read-only-summary.json`: all 20
targets were inspected, 1 was terminal, 19 were open, 5 fit the bounded recovery preview, and the
remaining 14 were skipped only by the recovery budget. There were no inspection failures, so
`skip_reasons` is empty.

## Gates

- `pnpm run build:all`: passed
- `pnpm run test:no-build`: 3,316 tests; 3,307 passed, 9 skipped, 0 failed
- `pnpm run lint`: passed
- `pnpm run format:check`: passed
- `pnpm run check:active-surface`: passed

## Limits and Bay impact

This production observation proves the token-boundary diagnosis and the successful-target summary.
The focused operator tests cover reason classification, bounded samples, credential and control-byte
sanitization, and output truncation. The replay did not mutate production queue state and cannot
prove the production Worker's signed list route beyond the immutable uploaded artifact.

OpenClaw Bay is unaffected. The change adds diagnostic fields to an operator-only JSON summary; it
does not change lifecycle publication, dashboard data, or the observer-only Bay surface.
