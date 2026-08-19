# Recovery-cap classification behavior contract

## User-visible goal

An operator reading a reconciliation summary can distinguish recovery-budget skips and
queue-pressure deferrals from inspection failures without changing recovery behavior.

## Target

- Type: CLI JSON output
- Access: `node scripts/exact-review-dead-letter-operator.mjs --action reconcile-parked`
- Allowed fixture: immutable `parked-reviews.json` from ClawSweeper Actions run `31449984643`,
  artifact `9085971968`
- Allowed credential source: `GITHUB_TOKEN` from the authenticated `gh` session; never print it

## User tasks

1. Preview the production inventory without `--execute` and read its skip classes.
2. Run the focused operator fixtures covering parked and standard reconciliation.
3. Confirm inspection failures retain their existing HTTP/timeout classes.

## Expected observable behavior

- Open targets beyond `--max-recoveries` increment `skip_reasons.recovery_cap` exactly once each.
- Recoveries deferred while `queue_pressure` is non-idle increment
  `skip_reasons.recovery_deferred_pressure` exactly once each.
- Excluded, ineligible, or otherwise skipped targets do not inflate either new class.
- HTTP 403 and timeout failures remain classified as `http_403` and `timeout`.
- The production replay reports `dry_run: true` and cannot reach a mutation route.

## Anti-cheat probes

- Mix a capped target with an excluded parked target and require only the capped target to be
  classified.
- Mix an active/ineligible standard target with a capped target and compare the summaries.
- Exercise non-idle pressure in both reconciliation paths.
- Preserve the existing mixed HTTP 403/timeout failure fixture.

## Evidence required

- Red focused-test failure showing all three missing classes before the implementation.
- Green focused-test result after the implementation.
- Exact production replay summary and immutable artifact identity.

## Out of scope

Queue mutations, new queue telemetry bookkeeping, dashboard status logic, and OpenClaw Bay actions.
