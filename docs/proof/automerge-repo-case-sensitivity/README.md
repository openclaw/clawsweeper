# Repository-slug case-sensitivity proof contract

## Claim

A parsed GitHub repository slug is matched case-insensitively, so a
`canonical_pr` (or `source_prs` entry) that names the target repository with
different casing resolves normally. Before this change the comparison was
byte-exact, so `https://github.com/OpenClaw/OpenClaw/pull/83707` did not match
the configured `openclaw/openclaw` and the reviewed head SHA was dropped.

Matching stays bounded: a genuinely different repository is still rejected, so
this cannot widen into cross-repository head borrowing.

## Exercised surface

`automergeOutcomeReviewedShaFromResult()` in `dist/repair/automerge-outcome.js`
is the reported site and the one measured before/after.

The same defect existed at every site that compared a slug returned by
`parsePullRequestUrl` / `parseIssueOrPullRef`. Those parsers match with the `i`
flag and return the slug **verbatim**, so a case-differing slug never equalled a
configured one. All of them now use the shared `sameRepoSlug` comparator:

- `automerge-outcome.ts`
- `execute-fix-github.ts`
- `execute-fix-artifact.ts`
- `post-flight.ts`
- `source-pr-checkout.ts`
- `target-validation.ts`

Claim 3 below re-derives that list from the built output rather than trusting the
diff, so a site added later without the comparator fails the proof.

## Controlled scenario and fixture

`run-proof.mjs` asserts three claims against the built `dist/`:

1. **Resolves** — `canonical_pr` in three casings (`OpenClaw/OpenClaw`,
   `openclaw/OPENCLAW`, and a mixed-case `GitHub.com` host) each return the
   reviewed head, alongside an exact-case control.
2. **Bounded** — three genuinely different repositories are still rejected,
   including the near-miss `openclaw/openclaw-state`. An absent slug never
   satisfies a repository guard, so the comparator cannot degrade into
   "empty matches everything".
3. **Consistent** — the built output of all six consumer modules is scanned for a
   parsed slug compared with `===`/`!==` instead of the shared comparator. Any
   match fails the proof.

The before/after contrast compiles the **pre-fix** `automerge-outcome.ts` and
`github-ref.ts` from the base commit inside the lease (their runtime import
closure is just those two files — `json-types` is type-only and erases). If that
build is unavailable the proof reports SKIPPED and **fails**, rather than
quietly asserting an unmeasured contrast.

## Expected observation

17 checks, all PASS, exit 0, plus the measured contrast:

```
https://github.com/OpenClaw/OpenClaw/pull/83707
  pre-fix : null  (reviewed SHA dropped)
  post-fix: 92dca8fde03aee8da56a84a011fa387b9c1640fe
```

Cross-repository rejection is asserted in **both** builds, showing the fix
changed only the case dimension.

## Artifact and command

```bash
crabbox run \
  --provider local-container \
  --local-container-image node:24 \
  --no-hydrate \
  --timing-json \
  --artifact-glob '.artifacts/automerge-repo-case-proof/**' \
  --script docs/proof/automerge-repo-case-sensitivity/run-proof.sh
```

The script runs `pnpm run build:node`, **not** `build:repair`: `test/helpers.ts`
(used by `post-flight.test.ts`) imports `dist/clawsweeper.js` and
`dist/review-activity-cursor.js` from the main build, so the repair lane alone
leaves the focused suites unable to load. An earlier revision of this script made
exactly that mistake and the lease failed on it.

Host-only quick check (supply a pre-fix build directory for the contrast):

```bash
pnpm run build:node
node docs/proof/automerge-repo-case-sensitivity/run-proof.mjs /path/to/pre-fix/dist/repair
```

Focused tests:

```bash
node --test test/repair/automerge-outcome.test.ts test/repair/execute-fix-github.test.ts \
             test/repair/post-flight.test.ts test/repair/source-pr-checkout.test.ts
```

## Provenance

- provider: Crabbox `local-container` (Docker/OrbStack)
- crabbox: `0.15.0`
- image: `node:24` @ `sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584`
- container node: `v24.19.0` (satisfies `engines.node >= 24`)
- lease: `cbx_fe1bec2bb1b0` (`amber-barnacle`)
- run: `run_194358f6840f`
- artifact: `.crabbox/runs/run_194358f6840f/run_194358f6840f-artifacts.tgz`
  (`proof-output.txt`, `focused-tests.txt`, `install.log`, `build.log`,
  `prefix-build.log`)
- result: exit `0`; 17/17 proof checks PASS; focused suites `18/18`
- privacy: synthetic fixtures and public repository slugs only. The proof makes no
  network call, contacts no GitHub API, and performs no queue, GitHub, or
  production mutation.

## Limits

Covers the repository-slug comparison only. It does not change URL parsing, the
allowed host, item-number matching, or any other guard.

The change is **one-directional**: it can only turn a "different repository"
verdict into "same repository" when the two slugs differ solely by case. It can
never cause a previously-matching slug to stop matching. That bounds the risk of
touching the low-coverage `execute-fix-artifact.ts` mechanically.

Claim 3 scans **built output** for the specific `parsed.repo === …` shape. A site
that compares a parsed slug through a differently-named local variable would not
be caught by that regex; the six modules listed were enumerated by hand from the
`parsePullRequestUrl` / `parseIssueOrPullRef` call graph.

The proof exercises no live GitHub redirect. That `github.com` serves
case-differing slugs is GitHub's documented behavior, relied on here rather than
demonstrated.
