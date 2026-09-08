# Repair command deadline proof

Active executable proof owned by repair intake dispatch and target checkout preparation.
Run from the repository root after `pnpm run build:node`:

```sh
node docs/proof/repair-command-deadlines/run-proof.mjs /opt/homebrew/bin/gh
```

The default binary path is for macOS; pass the native GitHub CLI path on another host.
The proof starts a local stalled CONNECT proxy and runs the compiled dispatch
owner and worker CLI with native gh children. Synthetic credentials and the
mandatory proxy prevent GitHub mutations. Both children must return ETIMEDOUT
at the configured 30-second floor. It also checks the durable dispatch claim,
wait/no-duplicate behavior, observed recovery, and absence of a planner artifact
after clone failure. A successful real local Git clone runs through a small gh
argument adapter, with no remote repository access. Another adapter launches a
real Git HTTPS clone against the stalled proxy and verifies the entire clone
process group is gone after timeout and worker SIGTERM cancellation, covering
descendants beyond gh itself. SIGINT, SIGTERM and SIGHUP clean up the clone;
uncatchable process or host termination remains outside this JavaScript guarantee.

The JSON trace is the observable proof artifact. Fast regression tests separately
cover default budgets, override precedence, invalid values, longer clone budgets,
checkout selection and failure cleanup. This is not a live GitHub workflow or an
atomic dispatch guarantee; observation remains responsible for uncertain results.
OpenClaw Bay is unaffected because the ledger and status contracts are unchanged.

Update this proof when dispatch ownership, clone invocation or deadline policy
changes. Verified against the accompanying timeout repair using Node 24 and gh 2.100.0.
