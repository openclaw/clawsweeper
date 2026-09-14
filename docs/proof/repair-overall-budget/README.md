# Overall repair budget proof

Claim: the production workflow budget resolver gives OpenClaw 100 executor
minutes and 102 Actions step minutes at its configured 25-minute validation
budget, honors overrides, and never exceeds 110/112 minutes. All edit-worker
prompts defer full acceptance to the executor; contained validation remains required.

Run on Linux after `pnpm run build:node`:

```sh
node docs/proof/repair-overall-budget/run-proof.mjs /tmp/repair-overall-budget-proof.json
node docs/proof/validation-budget/run-proof.mjs /tmp/repair-acceptance-proof.json --timing-summary
```

The first command launches the real workflow resolver against a synthetic job
and reads its Actions output file for configured, overridden, and ceiling cases.
It renders the production worker instructions. The second executes a real pnpm
changed gate through production Linux containment and verifies successful timing
output and checkout identity. Unit/source tests cover repair-fix prompt wiring.

Limits: synthetic scripts do not measure compiler performance or prove an agent
will follow instructions. The separately authorized final replay owns publication,
wall time, and runner-minute measurements. No worker transcript is trusted as an
acceptance receipt, and no checkout or containment guard is relaxed. OpenClaw Bay
is unaffected: no public status, ledger, or dashboard data contract changes.
