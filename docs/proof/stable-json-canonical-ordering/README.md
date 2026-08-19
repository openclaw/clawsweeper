# stableJson canonical-ordering proof contract

## Claim

`stableJson` produces a canonical form: the same key/value set always serializes
to the same bytes, on any runtime, in any locale. Before this change it ordered
keys with `String.prototype.localeCompare`, which is neither a strict total order
nor locale independent — so the same input could hash two different ways.

The fix does **not** invalidate any stored digest. Every persisted digest shape
produced by the affected call sites serializes byte-identically before and after.

## Exercised surface

`dist/stable-json.js` — the module every content digest and canonical equality
check goes through — plus the two array sorts in
`src/clawsweeper-context-hydration.ts` that fed `pullChecksDigest` through the
same comparator.

Note that `src/review-structural-cache.ts` and `src/review-semantic-cache.ts`
already imported `stableJsonCodeUnit as stableJson`, so the review caches were
never exposed to this defect and are untouched by the fix.

## Controlled scenario and fixture

`run-proof.mjs` asserts three claims against the built `dist/`:

1. **Canonical** — for keys that `localeCompare` reports as equal (zero-width
   joiner, soft hyphen), two objects built in opposite insertion orders serialize
   identically. The proof first asserts the tie exists, so it cannot pass
   vacuously on a runtime where those characters are not ignorable.
2. **Byte order** — `{a, B}` serializes with `B` first (0x42 < 0x61), and the
   `cs-CZ`-sensitive trio `changedFiles` / `checksDigest` / `commitCount` keeps
   byte order. Czech collates `ch` after `h`, which reorders exactly those keys.
3. **No churn** — nine persisted digest shapes, copied from every call site that
   imports the locale-ordered `stableJson`, serialize byte-identically to a
   **pre-fix build compiled from the base commit**. The pre-fix module is compiled
   inside the lease from `git show <base>:src/stable-json.ts`; if it is not
   supplied the proof reports SKIPPED and fails rather than passing silently.

Claim 2 also pins a documented caveat: array-index-like keys (`"2"`, `"10"`) are
**not** byte-ordered. `Object.fromEntries` rebuilds the object and the engine
re-applies its ascending-numeric order for those keys, which the comparator cannot
override. That ordering is ECMAScript-specified and locale independent, so the form
stays canonical — it simply is not purely byte-ordered.

## Expected observation

18 checks, all PASS, exit 0. Pre-fix, claims 1 and 2 both fail:

```
insertion-order independence: VIOLATED
   built one way : {"ab":1,"a‍b":2}
   built other   : {"a‍b":2,"ab":1}
byte-defined key order    : VIOLATED -> {"a":1,"B":2}
```

## Artifact and command

Supported-environment run (Node 24, Crabbox `local-container`):

```bash
crabbox run \
  --provider local-container \
  --local-container-image node:24 \
  --no-hydrate \
  --timing-json \
  --artifact-glob '.artifacts/stable-json-canonical-proof/**' \
  --script docs/proof/stable-json-canonical-ordering/run-proof.sh
```

Host-only quick check (supply a pre-fix build for claim 3):

```bash
pnpm run build
node docs/proof/stable-json-canonical-ordering/run-proof.mjs /path/to/pre-fix/stable-json.js
```

Focused tests (the ledger test pins the shared-JSON ordering contract, so run both):

```bash
node --test test/stable-json.test.ts test/action-ledger.test.ts
```

## Provenance

- provider: Crabbox `local-container` (Docker/OrbStack)
- crabbox: `0.15.0`
- image: `node:24` @ `sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584`
- container node: `v24.19.0` (satisfies `engines.node >= 24`)
- lease: `cbx_9800bb5dbeab` (`jade-barnacle`)
- run: `run_b276f842aa3d`
- artifact: `.crabbox/runs/run_b276f842aa3d/run_b276f842aa3d-artifacts.tgz`
  (`proof-output.txt`, `focused-tests.txt`, `install.log`, `build.log`)
- result: exit `0`; 18/18 proof checks PASS; focused suite `6/6`
- privacy: synthetic fixtures only. The proof makes no network call, contacts no
  GitHub API, and performs no queue, GitHub, or production mutation.

## Known churn, and why it is safe

One shape does change: the **activity receipt**
(`stableJson(completeActivityContext)`) flips `reviews` and `reviewThreads`,
because `localeCompare` orders `s` before `T` while code units order `T` (0x54)
before `s` (0x73).

That value is never persisted. It is produced at
`src/clawsweeper-apply-decision-workflow.ts:950` and compared at
`src/clawsweeper-apply-proof-freshness.ts:132` — both inside a single apply run,
in one process, from one build. Both sides shift identically, so the comparison
still matches. It is deliberately excluded from the claim-3 fixture set, which
covers only digests that outlive a run.

## Limits

Covers key ordering only. It does not change what goes *into* any digest, the
allowed value types, or `JSON.stringify` semantics.

Claim 3 covers nine shapes — one per call site that imports the locale-ordered
`stableJson` — but it is **evidence, not an exhaustive proof**. The payloads are
built from live GitHub data, so a field set that never appears in these fixtures
cannot be ruled out by them.

The residual risk is precisely characterizable: churn requires two **sibling keys
in the same object** that the two comparators order differently. That happens when
they differ only by case (`Accept` vs `accept` — code units put uppercase first,
collation treats case as a tertiary difference) or straddle a locale-specific
digraph boundary (Czech `ch`). None of the real digest payloads mixes cased
siblings; they use consistent `camelCase` or `snake_case`.

An attempt to make this exhaustive by scraping every object-literal key from the
consuming modules and checking all 827,541 key pairs was **rejected as unsound**:
that universe includes keys never passed to `stableJson` (HTTP headers such as
`Accept` and `Authorization`, dashboard SQL columns), so its 15,246 "disagreements"
are false positives that say nothing about actual digest payloads. Narrowing the
universe correctly needs AST-level extraction of the payload literals, which is not
justified for a P2 determinism fix.

**Deliberately out of scope:** `src/clawsweeper-source-revision.ts:73` sorts
comments by `` `${id}:${updated_at}`.localeCompare(...) ``. That has the same root
cause, but fixing it *does* change `item_source_revision` for essentially every
item — collation orders `:` before digits while code units order it after, so ids
of differing digit length reorder. That is a migration-bearing change and needs
its own PR and its own re-review-wave decision.
