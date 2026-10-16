# Apply result completeness proof

Claim: current apply observations cannot imply measured result totals. A missing
completed ledger keeps totals unknown and is counted per field. Running applies
and failures before apply started do not dilute completed-result coverage.

Run with Node 24 or newer:

```sh
node docs/proof/apply-result-completeness/run-proof.mjs
```

The real producer runs in a child process for four scenarios: a measured success,
a completed apply with no ledger, a proof-only failure, and an active apply.
Its signed HTTP requests pass through the production Worker intake, StatusStore,
and public projector. The default runs the handlers on loopback with a temporary
SQLite KV adapter; its report explicitly excludes Cloudflare platform behavior.
An isolated workerd listener can be selected with `APPLY_PROOF_ORIGIN` and the
matching fixture-only `APPLY_PROOF_SECRET`. Only loopback origins are accepted.

The report prints the source head and diff digest, measured/missing counts,
preserved null totals, and the Operations data consumed by the page. Scratch is
deleted on exit. No production, GitHub, apply/close, or deployment action runs.
The removed OpenClaw Bay surface is unaffected; only the existing apply API and
Operations page consume this additive contract.
