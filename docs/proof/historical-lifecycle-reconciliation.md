# Historical lifecycle reconciliation proof contract

## Claim

`historicalLifecycleReconciliationReport` is a bounded, deterministic dry-run
classifier for a pre-captured immutable lifecycle cohort. It cannot contact a
Worker, queue, GitHub, R2, Actions, or the lifecycle store, and it never
imports historical facts into the Workstream 2 reducer.

## Exercised surface and fixture

The focused test builds one valid retained projection, captures it in a
sha256-shaped cohort identity, and invokes the report twice at one fixed clock.
It also exercises missing provenance, an over-cap cohort, and an expired cohort.

## Expected observation

The valid retained row is counted only as `not_reconciled`; `completed` is
always zero. Invalid or unavailable evidence is `Unknown`, never inferred from
workflow success. The source projection serializes identically before and after
both calls, proving the helper is idempotent and read-only.

## Artifact and command

`node scripts/run-node-tests.mjs all -- --test-name-pattern='historical lifecycle reconciliation'`
records the named fixture assertion. The normal build and full unit run are
also required before publication.

## Limits

The cohort is capped at 128 rows, requires retained-snapshot provenance and a
short explicit expiry, and reports no row identifiers. This facility is not an
executor or a backfill. Any future selection of an actual historical cohort or
any lifecycle mutation requires separately authorized maintainer work.
