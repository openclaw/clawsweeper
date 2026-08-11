# Parked reconciliation skip-reason behavior contract

## User-visible goal

A maintainer running parked reconciliation can distinguish GitHub inspection failures from ordinary
capacity skips without leaking credentials or unbounded error text.

## Target

- Type: CLI
- Access: `node scripts/exact-review-dead-letter-operator.mjs --action reconcile-parked`
- Allowed fixture: the immutable 20-row production artifact from run 31449984643
- Allowed credential source: `GITHUB_TOKEN` from Peter's authenticated `gh` session

## User tasks

1. Run reconciliation without `--execute` against the production inventory.
2. Read the terminal JSON summary and identify classified targets and inspection failures.

## Expected observable behavior

- The command remains read-only and reports `dry_run: true`.
- Every production row is accounted for by terminal, open, excluded, capacity-skipped, or
  inspection-failed outcomes.
- Inspection failures populate bounded `skip_reasons` counts and at most three sanitized
  `skip_samples`; a run without inspection failures emits empty containers.
- Summary text does not expose credentials or control bytes, and individual reasons are at most 240
  characters.

## Anti-cheat probes

- Contrast the same 20-row inventory under the scheduled workflow token and Peter's personal token.
- Require the personal-token counts to account for all 20 rows.
- Run focused fixtures containing multiple status classes, credential-shaped text, control bytes,
  and overlong messages.

## Evidence required

- Exact terminal summary
- Immutable production run and artifact identity plus SHA-256 hashes
- Focused test and full gate results
- Fresh PR container result and lease identity

## Out of scope

Queue mutations, production secret retrieval, dashboard rendering, and OpenClaw Bay.
