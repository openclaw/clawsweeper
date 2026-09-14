# Validation budget proof

Active executable proof owned by repair execution and target validation.
Update when budget selection, process containment, or disposable ownership changes.

Claim: the checked-in configuration gives only OpenClaw a 20-minute repair
validation budget, and a timed-out changed gate reports a timeout after its
entire command tree exits and its newly generated lock is removed.

Run on Linux after `pnpm run build:node`:

```sh
node docs/proof/validation-budget/run-proof.mjs /tmp/validation-budget-proof.json
```

The proof executes a real `pnpm check:changed` package script in a synthetic Git
checkout through production namespace containment. Its primary Node process
and detached child ignore SIGTERM; the child attempts a delayed artifact write.
The observable JSON trace records the selected budgets, wall time, timeout
diagnostic, removed lock, absence of the delayed write, and unchanged Git status.
Regression tests additionally cover existing ownership, unrelated artifacts,
tracked mutations, invalid overrides, and unverified supervisor completion.

This scaled timeout proof does not measure OpenClaw's compiler or runner cost;
the separately dispatched production pilot owns those measurements. OpenClaw
Bay needs no change: ledger, status, and public data contracts are unchanged.
