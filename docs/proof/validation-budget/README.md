# Validation budget proof

Active executable proof owned by repair execution and target validation.
Update when budget selection, process containment, or disposable ownership changes.

Claim: the checked-in configuration gives only OpenClaw a 25-minute repair
validation budget, and a timed-out changed gate reports a timeout after its
entire command tree exits and its newly generated lock is removed.

Run on Linux after `pnpm run build:node`:

```sh
node docs/proof/validation-budget/run-proof.mjs /tmp/validation-budget-proof.json
node docs/proof/validation-budget/run-proof.mjs /tmp/validation-identity-proof.json --inconclusive-identity
node docs/proof/validation-budget/run-proof.mjs /tmp/validation-timing-proof.json --timing-summary
```

The proof executes a real `pnpm check:changed` package script in a synthetic Git
checkout through production namespace containment. Its primary Node process
and detached child ignore SIGTERM; the child attempts a delayed artifact write.
The observable JSON trace records the selected budgets, wall time, timeout
diagnostic, removed lock, absence of the delayed write, and unchanged Git status.
Regression tests additionally cover existing ownership, unrelated artifacts,
tracked mutations, invalid overrides, and unverified supervisor completion.

The inconclusive-identity scenario deliberately removes the synthetic checkout's
HEAD during the real timed-out command. The following real Git proof cannot
complete: the timeout must remain primary, both errors must survive, and reuse
must be blocked. After proving all target processes exited, the harness restores
its deliberate damage and disposes its retained fixture state. This reproduces
the diagnostic collision observed in the live pilot; it does not claim HEAD
damage caused that pilot's inconclusive proof.

The timing-summary scenario runs a successful real pnpm script that requires
`--timed` and emits known synthetic stage durations on stderr. It verifies that
the validator logs only core typecheck, core-test typecheck, and core lint rows
(full-lane, single-file, and multiple-file labels),
while preserving checkout identity. Those fixture numbers prove plumbing, not
compiler performance; the real pilot supplies measured stage durations.

This scaled timeout proof does not measure OpenClaw's compiler or runner cost;
the separately dispatched production pilot owns those measurements. OpenClaw
Bay needs no change: ledger, status, and public data contracts are unchanged.
