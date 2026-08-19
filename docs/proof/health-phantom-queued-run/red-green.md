# RED/GREEN transcript

## Round 3 RED — unbounded candidate branch

The 205-row fixture was added before the batch selector changed and run at
`62738988033d1924a4274331a6f2bd7d5cfd03aa`:

```text
$ pnpm run build:all && node --test \
    --test-name-pattern='caps stale queued-run revalidation' \
    test/github-webhook-read-model.test.ts
tests 1
pass 0
fail 1
duration_ms 2038.838042

AssertionError: Expected values to be strictly equal:
205 !== 10
```

The unbounded refresh issued all 205 exact reads and the delayed fixture took
1,850 ms. This directly reproduced the accepted P1: five-way concurrency
limited simultaneous reads but not total reads or end-to-end refresh work.

## Round 3 GREEN — fixed batch and rotation

```text
$ pnpm run build:all && node --test \
    test/github-webhook-read-model.test.ts \
    test/dashboard-operational-health.test.ts
tests 22
pass 22
fail 0
duration_ms 2302.046709
```

The first refresh issued exactly 10 exact reads, selected the ten oldest rows,
returned within the fixture's 500 ms bound, omitted 195 unconfirmed rows from
queue pressure, and made health `unknown`. Twenty-one refreshes selected each
of the 205 rows exactly once and emptied the backlog; the final status was
healthy. The completed, absent, genuinely queued, failed-read, zombie, and
missing-subscription cases from rounds 1–2 remained green.

The real Wrangler/SQLite Durable Object proof used 205 backlog rows plus the
original completed and absent rows. It issued 207 unique exact reads across 21
batches, never exceeded 10 reads in one refresh, reported 197 initial
omissions, observed `unknown` until the backlog drained, then returned healthy.
The initial cache miss took 157 ms and stale-cache responses took 6–35 ms.

## RED — fresh `origin/main`

The new loopback fixture was added before production code changed and run from
fresh `origin/main@e17e09425b604aeb6db9fb56494f640a9454ec97`:

```text
$ pnpm run build:all && node --test test/github-webhook-read-model.test.ts
tests 8
pass 7
fail 1

dashboard health revalidates and evicts stale phantom queued runs
AssertionError: expected "healthy", actual "degraded"
```

The repair-only/no-subscription probe already passed, confirming that the
complete-census plus event-class gate correctly forced the pre-#1167 live poll.
The failure reproduced the separate per-row eviction gap.

## GREEN — candidate

```text
$ pnpm run build:all && node --test \
    test/github-webhook-read-model.test.ts \
    test/dashboard-operational-health.test.ts
tests 21
pass 21
fail 0
```

The completed and absent exact-run verdicts both produced healthy status,
`queued_over_threshold=0`, durable row eviction, and structured telemetry. The
genuine queued verdict stayed degraded and refreshed its confirmation time. A
503 exact-run probe became `unknown` with zero queued-over-threshold count, and
a repair-fed snapshot without `workflow_run` subscription coverage stayed on
the live-poll path.

The first complete host gate also passed:

```text
$ pnpm run check
tests 3465
pass 3456
fail 0
skipped 9
```
