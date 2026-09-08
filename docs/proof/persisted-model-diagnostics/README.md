# Persisted-model diagnostics proof

- Status: historical repair proof recipe; not an operational runbook or a live review attestation
- Owner: ClawSweeper review and publication maintainers
- Baseline: `66af14ef3f725f5ecb1c0ab8f6b085cc40b3d642`
- Source of truth: the production detector, hydration and report-rendering owners recorded by the script
- Update when: those owners, the pinned fixture, or this recipe change; rerun both modes before reusing a receipt

## Claim and exercised surfaces

A transient stdout/IPC diagnostic refactor must not create persisted-data-model
flags, a SQLite table warning, or a migration/upgrade compatibility blocker. Real
persistence owners and stored-shape changes must still be blocked without
compatibility proof, and accept affirmative compatibility proof in an otherwise
valid report. This recipe checks that specific producer-to-renderer behavior,
not the correctness of an OpenClaw change or a model's review judgment.

[run-proof.mjs](run-proof.mjs) loads the actual compiled
`dataModelChangeFromContext` and `sqliteSchemaChangeFromContext` functions from
[src/clawsweeper-change-detection.ts](../../../src/clawsweeper-change-detection.ts).
It passes their results through synthetic report front matter into the production
`renderReviewCommentFromReport` export from `dist/clawsweeper.js`. The unchanged
report parser, readiness/compatibility gate, warning renderer and automation
markers run in memory. Report assembly is deliberately local fixture code; this
is not an end-to-end `markdownFor` or publication replay.

The normalized case calls the actual `createContextHydration.compactPullFile`
from [production hydration](../../../src/clawsweeper-context-hydration.ts), using
production `asRecord` as its only required adapter. Every unused injected
capability is a throwing function. There are no imports from test helpers, no
scratch capture dependencies, no temporary files and no CLI publication calls.
The only fixture dependency is the checked-in public JSON described below;
compiled production modules and installed dependencies must already be present.

## Input provenance and scenarios

The [public fixture](../../../test/fixtures/persistence-classifier-138520.json)
contains the sole changed file from
[OpenClaw PR 138520](https://github.com/openclaw/openclaw/pull/138520), pinned at
`e87dc59f30bfb77dad91d8f9229839a350fad3f7`. Its recorded provenance is a GitHub
pull-files API capture checked against the raw commit, **not archived worker
JSON**. This recipe does not refresh or independently recapture it. PR-body and
review-comment prose are not detector inputs, and its public comment reference
is not a fresh review attestation.

The exact API hunk body is 2,090 characters, SHA-256
`3a22d69f12982663c8dee1569c7c26ffdeba97777a7b0d6c8bd3516d357130de`.
The script asserts both length and hash. Production normalization must equal the
first 2,000 characters followed by `\n\n[truncated 90 chars]`; it must not be a
hand-normalized substitute. The full API input and its production-normalized
form are distinct scenarios.

The 24 scenarios preserve the original replay matrix:

- Four negative cases: the full pinned diagnostic patch, its normalized form,
  the same diagnostic filename with no patch, and generic stdout-only JSON.
- Fifteen positive controls: five SQLite owner filenames (board store, board
  codec, audit-record store, index schema, and user-version), each with a missing
  patch, a JSON-conversion edit, and a JSON-field edit.
- Five more positive controls: an SQL table column, persisted JSON, a missing
  SQLite-store patch, changed fields with unchanged same-hunk storage context,
  and the real diagnostic patch mixed with a table change.

All twenty positive controls must retain persisted flags/surfaces, a
compatibility blocker and a needs-human verdict without proof. Each must yield a
pass verdict with affirmative compatibility text. Negative cases must have no
persisted flags/surfaces, no SQLite classification/files/warning, no compatibility
blocker and a pass verdict. In every case, with and without compatibility proof,
the SQLite warning must match SQLite classification. Not every persistence
control is a table change: codec and user-version owners still need compatibility
proof without necessarily receiving a table warning.

## Reproduce offline

Use Node >=24, Git with the pinned baseline object available locally, existing
project dependencies, and a **fresh candidate build**. The build owner should run
`pnpm run build` using the repository's pinned pnpm 11.10.0 before either mode.
This script never builds, installs, fetches, checks out another revision or writes
files. Missing build artifacts or fixture drift produce exit 2 rather than a
partial proof. Local Git reads disable replacement objects and lazy fetching.

From the repository root, run these separately (baseline intentionally fails):

```bash
node docs/proof/persisted-model-diagnostics/run-proof.mjs --baseline
```

```bash
node docs/proof/persisted-model-diagnostics/run-proof.mjs
```

Both modes also work from any other working directory when invoked using the
script's full path: all repository reads and Git subprocesses are anchored to
its own location. Do not chain the commands with `&&`, since baseline exit 1 is
expected. Each command emits JSON to stdout; capture it locally if a receipt is
needed. No receipt is implied by the existence of this recipe.

Expected baseline: exit **1**, `passed: false`, `controlsPassed: true`, and exactly
these four entries in `failures`, in order:

```text
exact-pr-138520
normalized-pr-138520
sqlite-diagnostics-missing-patch
stdout-diagnostics
```

Expected candidate: exit **0**, `passed: true`, `controlsPassed: true`, and an empty
`failures` array. `expectedOutcomeObserved` should be true in both modes, but does
not convert the baseline regression into success. Per-case `failedChecks` name
each broken assertion; all assertions use the same desired behavior in both
modes. Errors or any extra failures require investigation, not relaxed checks.

JSON records the source HEAD, a hash of the working source diff against HEAD,
source and compiled hashes for a bounded owner inventory, the script and full
fixture hashes, exact and normalized patch hashes, detector input hash, baseline
revision, and Node/platform/architecture provenance. Provider is `local-node`;
image and lease are null because this recipe does not provision a container or
remote lease. Only repository-relative paths are emitted; no hostname, private
checkout location or model identifier is required. Rendered-comment hashes and
observed warnings/verdicts identify the exercised outputs without retaining full
synthetic reviews. Owner hashes are not a complete dependency manifest or an
attestation that the build is fresh; the build owner is responsible for that.

## Recorded local result

[candidate.json](candidate.json) and [baseline.json](baseline.json) record this
recipe run on Node v24.20.0, macOS arm64, with source HEAD
`0c05db6804c797e671d0c0a6c4e3c8a10d5993d5` plus the working detector patch identified
by the receipt's source/diff hashes. Candidate exited 0 with all 24 cases passing;
baseline exited 1 with exactly the four expected negative-case failures. All
twenty persistence controls passed in both modes, including acceptance of the
synthetic affirmative compatibility statement. These are local observations,
not attestations of production review or actual migrations.

The baseline distinction is important: the full 2,090-character patch triggered
serialized-state and compatibility flags but no SQLite table warning. Production
normalization added the unknown-data-model flag and the SQLite classification and
warning. The candidate clears both forms without weakening the persistence
controls. Shared source and compiled owner hashes match between these receipts.

## Baseline boundary and limits

`--baseline` loads **only** the original detector TypeScript with
`git --no-replace-objects show 66af14ef3f725f5ecb1c0ab8f6b085cc40b3d642:src/clawsweeper-change-detection.ts`.
Node's `stripTypeScriptTypes` strips it in memory. Its sole runtime import is
resolved to the current compiled role classifier; detector logic is not changed.
The two historical detector functions supply classification results, while
current production role classification, hydration, renderer and all emitter
dependencies remain shared. Renderer-internal compatibility parsing also remains
current. This is a detector-only counterfactual, **not a complete historical
application build**. The role classifier, hydration and emitter dependencies are
unchanged by this patch; compare their recorded hashes between receipts.

All report review/lease/head/checkout-readiness metadata, the sufficient-behavior
assessment, and the affirmative migration sentence are **synthetic inputs** that
isolate this gate. They do not claim a host preflight, a completed model review,
an executed migration, or authorization to merge. The synthetic automerge label
only exposes verdict markers; nothing enables automerge.

No live model, GitHub read/publication, data migration, OpenClaw runtime,
production record mutation, repair of historical comments, or actual compatibility
execution is covered. This does not restart the retired
[automatic live-proof lane](../../live-proof.md). The controls are bounded, not a
complete storage-classifier matrix or browser/Durable Object runtime proof.
OpenClaw Bay is unchanged: this repair corrects producer classification while
preserving report fields and all observer API, lifecycle, telemetry and action
contracts; no Bay code, schema or execution is exercised here.
