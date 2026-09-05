# Portable cluster intake proof

The claim is that cluster intake accepts the store's raw and gzip snapshot
formats, treats empty portable cluster tables as an empty result, and preserves
processed-snapshot deduplication. Invalid gzip archive or decoded hashes must
fail before the workflow admits an import.

`run-proof.mjs` executes the actual `Prepare intake` shell from the workflow,
then the built importer against synthetic SQLite files. Empty cases also run
the real selector without credentials and assert that no candidate is selected.
The upstream store owns decompression and archive verification; intake copies its
materializer into a private temporary directory and checks a reviewed SHA-256
before execution. A changed publisher-supplied helper fails before import.
Provide the store's
`scripts/portable-artifact.mjs` to the proof rather than substituting a decoder.

Run on Node 24+ with Bash 4+, gzip, GNU coreutils, and dependencies installed, using the
repository's resolved Crabbox provider:

```sh
pnpm run build:node
node docs/proof/cluster-intake-portable/run-proof.mjs /tmp/portable-artifact.mjs .artifacts/cluster-intake-portable/candidate.json
node docs/proof/cluster-intake-portable/run-proof.mjs /tmp/portable-artifact.mjs .artifacts/cluster-intake-portable/baseline.json a9ed9b5ba7eb12357da7cc2360d87cc5397c3c36
```

The baseline runs its original workflow and TypeScript importer alongside
current compiled dependencies. Receipts include the source revision, dirty
state, workflow and importer hashes, materializer hash, runtime, and each
scenario's observable outcome. The baseline rejects gzip-only input and fails
on empty portable tables; the candidate accepts both, preserves raw input and
forced reimports, skips processed snapshots before decompression, and rejects
unreviewed materializer code and archive/decoded hash mismatches.

This is controlled runtime proof, not a production intake or inference call.
It does not restore clusters omitted by an upstream export, verify raw database
hashes beyond the store helper's contract, or exercise live GitHub publication.
OpenClaw Bay is unaffected: its public status and data contracts do not change.
