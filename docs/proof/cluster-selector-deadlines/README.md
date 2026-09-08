# Cluster selector deadline proof

Active executable proof owned by `src/repair/select-cluster-candidate.ts`.
Run from the repository root after `pnpm run build:repair`:

```sh
node docs/proof/cluster-selector-deadlines/run-proof.mjs /opt/homebrew/bin/gh
```

Pass a different native gh path on another host. The compiled CLI runs against
synthetic evidence in private temporary directories. Its existing fetch transport
is redirected to a local HTTP peer while preserving the production request and
AbortSignal. Separate requests stall before headers and during a partial JSON
body, each using the actual two-minute budget. A default native gh evidence read
stalls at a local CONNECT proxy and must stop at the configured 30-second floor.
Failure must publish neither a selected-path file nor a selection report.

Successful selected and rejected decisions also run through the compiled CLI and
native fetch. The selected case must perform the final-open GitHub read before
writing its normal durable output. These success cases use a synthetic gh adapter;
the GitHub timeout case uses native gh. All authentication is synthetic. There are
no live GitHub mutations or model calls.

The command prints a redacted JSON trace and removes its private fixtures.
Update the proof when selector I/O, its deadlines, or durable selection output
changes. Verified with this repair on Node 24 and gh 2.100.0. This proves local
transport behavior, not live model quality or GitHub availability. OpenClaw Bay
is unaffected: no public observer or status schema changes.
