# RED/GREEN transcript

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
