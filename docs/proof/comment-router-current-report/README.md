# Current comment-router report proof

The latest report must describe this invocation. A GitHub throttle before command
discovery must not inherit prior commands or count requested comment IDs as
discovered commands. Current partial reports and their event shards must survive.

```sh
pnpm run build:node
node scripts/e2e/comment-router-throttle-loopback.mjs
```

This runs the actual wrapper, built router and action-ledger finalizer against a
loopback HTTP GitHub fixture in an isolated temporary runtime. It seeds a stale
report, throttles before broad discovery, and repeats with an explicit comment ID
and no prior report. Both must report zero commands, preserve the durable ledger
and cursor, and satisfy the workflow's existing empty-finalization condition.
Another request discovers commands before throttling; its partial report and
real event shards must finalize successfully. Existing abuse/429, fatal-error and
incremental cursor recovery cases remain covered.

To reproduce the stale-report failure, pass the baseline wrapper revision as the
only argument. The harness uses current unchanged compiled dependencies with
that wrapper and must fail because the stale count is retained. The candidate
receipt records the current head, dirty state, wrapper hash, named assertions and
loopback requests.

Only synthetic credentials, repository identities and event producers are used.
No live GitHub calls, workflow dispatch, inference or production state mutations
occur. OpenClaw Bay is unaffected: no command ledger, cursor, event schema or
public projection contract changes.
