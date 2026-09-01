# Canonical label-sync recording proof

The effective addition/removal values produce the same recorded `issue_labels_sync`
identity across queue order and runner locale. Both lists use the existing
`compareCodeUnits`; normalized-key deduplication and last-operation-wins behavior
remain unchanged.

The executable connects the real batch producer to the real apply-ledger recorder,
reads persisted attempt/outcome events, and checks their business keys. Separate
Node children verify resolved en-US/sv-SE locales, reversed/sorted/rotated queues,
collator ties on both lists, exact values and arguments, duplicates, changed sets,
and distinct receipts for repeated synthetic adapter invocations. Children receive
fresh temporary home/config/cache/state directories and no inherited credentials,
workflow context, projection settings or runtime injection variables. Fixed
synthetic producer metadata enables local receipts inside each child; owned
canonical temporary roots are removed in `finally` after readback.

## Run

Use the repository root manifest and lockfile, their pinned package manager, Node
24 or newer with both ICU locales, and normally installed dependencies. From the
repository root:

```bash
pnpm run build
node docs/proof/label-sync-identity-determinism/run-proof.mjs
node --test --test-concurrency=1 test/label-mutation-batch.test.ts
```

For a contrast, separately prepare a compiled pre-fix label module with its normal
sibling imports, then name both inputs explicitly:

```bash
node docs/proof/label-sync-identity-determinism/run-proof.mjs \
  --baseline /path/to/prepared/dist/clawsweeper-label-mutations.js \
  --candidate dist/clawsweeper-label-mutations.js
```

Baseline success requires observed locale and collator-tie divergence; candidate
success requires the canonical golden identity/arguments and equal recorded keys.
A failed child, wrong resolved locale or setup error fails the probe. JSON includes
actual owner/recorder-module and manifest hashes, runtime versions, observations,
and receipt IDs without host paths. The focused test invokes this same executable.
Exact source/head, build provenance, provider and current execution evidence belong
in the PR body; these commands do not install, stage source or infer a Git base.

## Limits

As described in [Action Ledger](../../action-ledger.md#identity-and-replay), receipt
identity and execution policy are separate. The actual apply runner records an
attempt and then invokes the operation; this change adds no duplicate-edit gate.
The adapter counter is synthetic, not evidence of live GitHub or full apply effects.
Older locale-sorted records are not migrated. UTF-16 label ordering does not claim
to equal the ledger's UTF-8 ordering of canonical object keys. This proof establishes
canonical ordering of effective values, not collision-free encoding of all labels.
