# Readable Bay — controlled runtime proof

This directory contains the reproducible proof harness, not a claim that an
arbitrary checkout passed. The accompanying PR body must identify the current
candidate, successful run, findings disposition, validation and visual review.
A failed or incomplete run is retained as diagnostic evidence, never signoff.

## Claim and exercised surface

The production /bay page is served by the real local Worker and its closed
/api/status projection. Deterministic source snapshots persist through the real
StatusStore Durable Object, enter the production versioned status cache, and
pass through the unmodified public projection and browser validator. The harness
asserts collection completeness before UI comparisons and rejects private
sentinels. It does not fulfill API requests with Playwright mocks or replace the
application with standalone HTML.

A separate initial phase exercises actual ExactReviewQueue admission and durable
lifecycle finalization, including batch-inclusive versus direct timing. The UI
remains public, indexable and observer-only; batch publication and backend
mutation policies are unchanged.

## Environment and invocation

Comparison base: 97c9a7b45caf20f6d580fe0ae5cc48db31da15f4.
Use the repository-resolved Crabbox provider and an explicitly authorized existing
lease. This task uses Linux AWS proof, not an assumed Windows or local Docker
host. Use --no-hydrate to avoid Actions dispatch. Node >=24 and a sandbox-capable
Chromium installation are prerequisites; no TLS or browser-sandbox bypass is
permitted. Record actual provider, lease, image and tool versions with each run.

Stage intended source additions before proof. Crabbox sync transports working
files but not the caller index: inside the isolated synced lease, restore
intent-to-add for the explicitly intended new source files before running proof:

~~~sh
git add -N -- dashboard/bay-layout.ts test/bay-readable-layout.test.ts \
  docs/proof/bay-readable-layout/{README.md,fixture-worker.mjs,fixtures.mjs,run-proof.mjs,run-proof.sh,settled-master.mjs,wrangler.toml}
~~~

This changes only the isolated index, not source or commits. The runner rejects
missing source index entries instead of silently omitting them. Compare the
remote combined patch digest to the originating worktree before claiming proof.
The source manifest includes only
Git-tracked candidate files, not untracked files or private/generated Crabbox,
OpenClaw and artifact directories. The binary candidate patch excludes those
private/generated roots too; source deletions remain represented in the patch.
Use full-index patch digests so local and remote Git abbreviation settings
cannot change candidate identity.

From the candidate repository root **inside the admitted lease**, supply actual
BAY_PROOF_PROVIDER, BAY_PROOF_LEASE, BAY_PROOF_IMAGE,
PLAYWRIGHT_CHROMIUM_EXECUTABLE and BAY_PROOF_CANDIDATE provenance. For each attempt,
choose a new output and absolute scratch directory:

~~~sh
export BAY_PROOF_CANDIDATE="$(git rev-parse HEAD)+patch-sha256:$(git diff --binary HEAD --full-index -- . ":(exclude).crabbox/**" ":(exclude).openclaw/**" ":(exclude).artifacts/**" ":(exclude)artifacts/**" | sha256sum | cut -d' ' -f1)"
export BAY_PROOF_OUTPUT="$PWD/.artifacts/bay-readable-layout/attempt-N"
export BAY_PROOF_SCRATCH="$PWD/.openclaw/tmp/bay-readable-runtime-attempt-N"
bash docs/proof/bay-readable-layout/run-proof.sh
~~~

The runner validates that the supplied candidate equals the actual HEAD plus
the generated full-index source-patch digest, and refuses stale or mistyped
provenance before starting Workers. It refuses to overwrite prior evidence. It reconstructs the pinned base
with git archive, adds only fixture infrastructure to that baseline, installs
frozen dependencies, and starts separate local Workers and SQLite/R2 state.
HTTP ports are 8794/8795 and debugger ports 8796/8797; all bind to loopback.
Both pages receive the same scenario epoch and source data. The baseline’s old
path toggle is set to include batch work before comparison, aligning the data
population rather than changing its layout.

## Scenarios and assertions

The matrix covers normal, crowded, mixed-repository, long-reference, empty,
stale, partial-diagnostic, unknown-participation, terminal, active batch-fallback,
missing-timing, partial-activity and forward-transition fixtures. Viewports are
1440x1000, 1199x900, 768x1024, 430x932 and 360x800.

It checks bounded drawn slots while every available sample stays reachable;
aggregate/sample/drawn distinctions; all six active stages and both outcomes;
repository filters that leave timing unchanged; all inline-proof cohorts and
independent review-path selection; exact terminal-list
filtering; keyboard, pointer and touch; nested-modal forward/backward Tab,
Escape and focus return; refresh to newly persisted data, including removal of a
focused desktop card; resize retention and visible navigation-focus fallback;
longest cohort selection; normal/reduced motion, patrol resumption and tide preview. Browser
traffic must remain same-origin GET. Fixture seeding is separate local traffic
and never touches live producers or workflows.

Settled sweeper checks protect transformed bounds against visible records,
labels and controls, require a loaded visible asset inside the beach, and cover
viewport/area/resize changes. Active sweep, climb and settling overlap is
intentionally exempt. Mobile active layout position is independently checked
against the unchanged scene height; normal- and reduced-motion resting states
must regain clearance.

## Inspectable evidence

Each output directory contains:

- source-head.txt, candidate.patch, source-manifest.json and fixture hashes;
- durable-receipt-status.json and per-scenario public API responses;
- matched actual-page before/after PNGs and browser traces;
- measurements.json for header/chart, label overlap, 44px and first-screen checks;
- settled-master.json for resting clearance and active-motion observations;
- network.json, Worker logs and summary.json with explicit PASS/INCOMPLETE state;
- bounded focus or master-clearance diagnostics when those assertions fail.

Keep failed attempt directories alongside the succeeding run. The PR body must
link the actual current evidence, exact candidate/base, provider/image/lease,
commands, outcomes and limitations. Human inspection of representative desktop,
phone, crowded, long-reference and empty/partial images is a separate visual
review; a passing assertion suite alone does not provide that signoff.

## Supporting checks and publication gates

For narrow edit-speed regression checks:

~~~sh
node --test test/bay-duration-chart.test.ts test/bay-readable-layout.test.ts test/openclaw-bay-proof-network.test.ts
~~~

On the configured provider, build with pnpm run build:all and run the entire
canonical test/dashboard-worker-bay-records-routes.test.ts before repeating
pnpm run check. Those checks, lint and clean static review support but do not
replace the real matrix. Only results for the stated candidate count.

Fresh native Codex review precedes commit; committed branch-versus-base review
follows at the required boundary. Put current proof and findings disposition
in the main PR body before requesting ClawSweeper review. Current-head/current-
body review and CI remain owner work through maintainer-look readiness. No
merge, automerge or deployment is implied by this proof.

## Limits

Controlled snapshots prove local storage/cache/projection/UI integration, not
live producer execution, production throughput, or GitHub rate-limit recovery
itself. Batch classification uses the existing public contract and is not new
provenance. The receipt phase is real local lifecycle evidence, not a live
GitHub publication. Schema/cache-version drift must fail loudly; no validator,
privacy assertion or real retention limit may be weakened to make a fixture pass.
