# Proof: the issue label sync identity is the same on every runner

## Claim

The `issue_labels_sync:<number>:add=…:remove=…` identity recorded for a published
label mutation depends only on the label set — not on the order the labels were
queued, and not on the ICU locale of the machine that produced it.

### What this does *not* claim

This change does **not** prevent a duplicate GitHub label edit, and the proof does
not assert that it does. `src/clawsweeper-apply-decision-workflow.ts` records the
mutation attempt and then calls `options.operation()` unconditionally; nothing
consults the identity beforehand to suppress an edit. What the identity feeds is
`applyMutationBusinessIdempotencyIdentity` in `src/clawsweeper-apply-ledger.ts:274`,
which hashes it into the recorded ledger event.

So the property being fixed is that the recorded key is **canonical**: one label set
produces one key on every runner. An idempotency identity that varies by collation
cannot serve as a key for anything — audit correlation today, or an enforcement gate
later. Building that gate is a separate change; see the linked issue.

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

Proof contract — what a passing run must show. The **observed run for the current
head (lease, run id, artifact, redacted output) lives in the PR body**, which is
where AGENTS.md requires current proof to sit. No lease id is pinned here on
purpose: editing this file changes the head, which would immediately make a pinned
run describe a different commit than the one under review.

| | |
|---|---|
| provider | Crabbox `local-container` (runtime `docker`) |
| image | `node:24`; the script refuses to run below Node 24 |
| result | **PROOF PASSED** (all fixtures); focused suite `14/14`; exit `0` |
| head | echoed from `PROOF_HEAD`, forwarded with `--allow-env` |
| tracked state | unchanged at every checkpoint; identical `package.json` and `pnpm-lock.yaml` digests at sync and at end of run |

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

`.crabbox/runs/run_43d124d11e64/run_43d124d11e64-artifacts.tgz` holds
`.artifacts/label-sync-identity-determinism-proof/` with `before-output.txt`,
`proof-output.txt`, `focused-tests.txt`, and the install/build logs.

## The run cannot alter the head it is proving

The script records `package.json` and `pnpm-lock.yaml` digests plus
`git status --porcelain` at sync, then re-checks them after dependency installation
and at the end of the run; any drift aborts with a diff. The platform-native
TypeScript fallback installs into a disposable prefix outside the workspace rather
than writing tracked dependency metadata, so the recorded result does not disturb
the head it is describing.

## Limits

This proves the identity string and the ordering that feeds it. It does not call
GitHub, and it deliberately does not claim ledger enforcement: the mutation boundary
is stubbed because there is no pre-execution dedupe path in current source to
exercise. Read this as evidence that the key handed to the ledger is stable, not
that anything yet acts on it.

**Compatibility.** Records written before this change carry locale-sorted
identities, so their key differs from the one the same label set produces now. No
behavior depends on matching them today — nothing looks the identity up — but any
future dedupe gate has to treat pre-change identities as non-matching rather than
assume continuity.

The order of names inside the `--add-label` / `--remove-label` arguments changes as a
side effect; GitHub treats those as sets, so the resulting label state is unchanged,
but three existing assertions in `test/label-mutation-batch.test.ts` that pinned the
old collation order were updated to the new one.
