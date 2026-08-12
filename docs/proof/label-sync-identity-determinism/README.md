# Proof: the issue label sync identity is the same on every runner

## Claim

The `issue_labels_sync:<number>:add=…:remove=…` identity stamped on a published
label mutation depends only on the label set, not on the order the labels were
queued or on the ICU locale of the machine that produced it.

## Exercised surface

`createLabelMutationOperations(...).flushIssueLabelMutationBatch` in
`dist/clawsweeper-label-mutations.js`. That function sorts the batched additions and
removals and joins them into the `identity` passed to `ghObservedMutationCommand`.
The action ledger dedupes observed mutations on that identity, so two spellings of
the same key are two different keys.

## Scenario / fixture

`run-proof.mjs` drives the real batching API — `beginIssueLabelMutationBatch`,
`addIssueLabel`, `removeIssueLabel`, `flushIssueLabelMutationBatch` — with real
ClawSweeper label names (`P2`, `impact:message-loss`, `maturity:stable`,
`proof: sufficient`) plus a third-party name, and asserts:

1. **Queue order** — reversed, sorted and rotated queue orders all produce the
   baseline identity.
2. **Collator ties** — `"status: 👀‍ ready"` and `"status: 👀 ready"` differ only by a
   zero-width joiner. They are distinct strings that `localeCompare` ranks as equal
   (the run prints the `0`), so a comparator that returns 0 leaves them in input
   order and the identity follows the queue.
3. **Byte-for-byte** — the exact key for a fixed set is asserted in full, which is
   only possible because code unit order is specified.
4. **Two runners** — the file re-executes itself twice with `LC_ALL` set to
   `en_US.UTF-8` and `sv_SE.UTF-8` and compares the two keys.

## Command and environment

```
bash docs/proof/label-sync-identity-determinism/stage-before.sh
crabbox run --provider local-container --local-container-image node:24 --no-hydrate \
  --artifact-glob '.artifacts/**' -- \
  bash docs/proof/label-sync-identity-determinism/run-proof.sh
```

Recorded run:

| | |
|---|---|
| provider | `local-container` (runtime `docker`) |
| image | `node:24` → `v24.19.0`, `Linux aarch64` |
| lease | `cbx_22f9e117ae32` (`swift-hermit`) |
| run | `run_16ab137d00ec` |
| base staged | `5439582b` · `src/clawsweeper-label-mutations.ts` · sha256 `f2fee8cc…f846` |
| exit | `0` |

`stage-before.sh` exists because container images carry no `.git`: it writes the
base version of the changed file into `before/` on the host, where rsync picks it up
as a dirty file. When git *is* available `run-proof.sh` re-derives that file, so the
staged copy cannot drift from the base commit.

The script refuses to run below Node 24, installs the pinned pnpm into a
user-writable prefix, builds the Node lane, and runs the fixtures twice: once
against the module compiled from the base commit and once against this branch.

## Observed result

Against the pre-fix module the two runners disagree:

```
en_US.UTF-8  issue_labels_sync:321:add=Alpha|apple|äpple|zulu:remove=
sv_SE.UTF-8  issue_labels_sync:321:add=Alpha|apple|zulu|äpple:remove=
```

The tied emoji names also follow queue order rather than sorting deterministically.
Against this branch both runners emit
`issue_labels_sync:321:add=Alpha|apple|zulu|äpple:remove=` and every assertion
passes. A batch still publishes a mutation in both runs, which is what shows the
change only affects ordering; the script fails the proof if that ever stops holding.

## Artifact / trace

`.crabbox/runs/run_16ab137d00ec/run_16ab137d00ec-artifacts.tgz` holds
`.artifacts/label-sync-identity-determinism-proof/` with `before-output.txt`,
`proof-output.txt`, `focused-tests.txt`, and the install/build logs.

## Limits

This proves the identity string and the ordering that feeds it. It does not call
GitHub and does not exercise the ledger's dedupe path end to end — it establishes
that the key handed to the ledger is stable, not what the ledger then does with it.
The order of names inside the `--add-label` / `--remove-label` arguments changes as a
side effect; GitHub treats those as sets, so the resulting label state is unchanged,
but three existing assertions in `test/label-mutation-batch.test.ts` that pinned the
old collation order were updated to the new one.
