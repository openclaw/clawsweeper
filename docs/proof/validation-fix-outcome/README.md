# Validation-fix failure outcome

Status: active validation recipe. Owner: repair execution. Source:
`src/repair/execute-fix-artifact.ts`, especially `runCodexValidationFix` and the
outer blocked-outcome handler. Update this proof when worker errors, validation,
or terminal reporting change.

The executor previously omitted the validation-fix phase from its recognized
worker timeout/failure errors. A timeout or silent nonzero worker exit therefore
escaped before the blocked report and recovery request were written.

```sh
pnpm run build:node
node --test test/repair/execute-fix-worker-errors.test.ts
node docs/proof/validation-fix-outcome/run-proof.mjs
node docs/proof/validation-fix-outcome/run-proof.mjs --timeout
```

The proof runs the actual built CLI against a real local Git origin and blobless
checkout. A synthetic edit introduces trailing whitespace. Real Git validation
rejects it and invokes a validation-fix worker. The first scenario exits silently
with status 1; the timeout scenario keeps a real subprocess alive until the
executor's minimum five-minute deadline expires. Both must produce a blocked
report with `requeue_required: true`, retain exit status 1, and perform no push or
PR creation. Receipts and diagnostic output are under `.artifacts/validation-fix-*`.

To reproduce the baseline, run the same recipe against a build of
`d47259a07a62294e032018259aaf117ef12ed4fe` with `--expect-missing-report`.
That control requires a missing report and an uncaught validation-fix failure.

Limits: Git, validation, process execution, deadlines, and report persistence are
real; GitHub, the input scanner, and model output use local synthetic adapters.
No target repository, model service, or production state is mutated. Raw worker
diagnostics retain their existing classification. This repair does not establish
the cause of a lost production runner or make slow target validation pass.
OpenClaw Bay's schema and observer-only controls are unaffected.
