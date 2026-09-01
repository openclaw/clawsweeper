# Retire automatic live proof behavior contract

## Claim

ClawSweeper publishes one ordinary code review without automatically executing
untrusted pull-request code. Exact-event and scheduled review jobs no longer
inspect, provision, execute, record, or wait for liveProofPlan. A normal exact
review remains eligible for direct publication regardless of the compatibility
field in its decision. Historical review records and already-produced proof
bundles remain renderable, publishable, and retractable.

## Exercised surface

- Production review prompt and decision schema.
- Exact-event and scheduled-review jobs in .github/workflows/sweep.yml.
- Exact-review bundle creation and direct-publication admission.
- Compatibility publication of historical live-verification artifacts.
- Public review comments and OpenClaw Bay lifecycle timing/Kanban filtering.
- The real local Worker HTTP boundary with its SQLite-backed `ExactReviewQueue`.

## Scenarios and observable results

1. A generated decision must use the compatibility-only empty live-proof shape:
   not_applicable, none, static_text, empty entry, and no steps.
2. Neither exact-event nor scheduled-review jobs invoke live-proof-review,
   provision proof-specific Go/tooling, or upload newly generated proof media.
3. Exact-event review bundles do not depend on a proof execution result, and
   direct publication has no proof-produced exclusion.
4. Scheduled review artifact upload depends only on the completed review shard,
   not proof inspection or execution.
5. Existing proof-bearing bundle fixtures still validate, fold their verification
   into historical reports, render Live Verification, and support recording
   retraction.
6. Focused workflow and prompt-policy tests fail against the former automatic
   execution contract and pass against the retired contract.
7. A Crabbox run on the repository-resolved provider and Node 24 installs the frozen
   lockfile and executes the focused production-contract tests at the tested
   commit.
8. OpenClaw Bay excludes the retired automatic-proof/legacy-batch path from its
   cards and one-hour timing by default, while an observer-only switch includes
   it without changing queue state.
9. Bay persists the direct-versus-legacy classification with retained timing and
   tide rows, and incomplete live-worker censuses subtract projection-level
   legacy counts from the default view.
10. Scheduled review shards and batch publishers remain in the opt-in historical
    view, while exact-artifact jobs replaying a committed direct lifecycle stay
    in the default direct-review view.
11. Durable canonical receipts encode the actual publication path with distinct
    `direct-v2:` and `batch:` identities, so successful batch publication cannot
    contaminate direct-review timing.
12. Failed or cancelled exact reviews remain visible as normal review outcomes
    even when they finish before any publication receipt exists.
13. Out-of-order tide rebuilds preserve pre-change direct classifications, and
    the Bay scope summary refreshes immediately when the observer toggles the
    historical view.
14. Scheduled exact-queue admissions remain in the normal direct-review view,
    while an exact-artifact publisher stays hidden as legacy until its committed
    direct-lifecycle replay step proves that it belongs to the direct path.
15. A tide containing only hidden legacy outcomes does not animate in the
    default Bay view, and the obsolete terminal-proof planner and its proof note
    are removed with the automatic execution feature.
16. Batch work retained only for terminal command acknowledgement keeps its
    legacy classification, while a retained direct tide row remains direct even
    after its shorter-lived timing and direct-outcome rows expire.
17. A queued direct-lifecycle replay step does not prematurely reclassify a
    legacy publisher, and enabling the historical switch immediately includes
    the current retained wash instead of permanently consuming it while hidden.
18. Pre-v2 direct lifecycle fences remain in the default view after short-lived
    direct telemetry expires, and rolling-deployment status caches that lack the
    new comparison aggregate are refreshed instead of served to Bay.
19. Hidden legacy queue rows cannot consume the entire bounded public-reference
    sample ahead of normal direct work, and the historical-view toggle does not
    resurrect outcomes that a completed tide already washed away.
20. A direct review remains visible when newer legacy publication work exists for
    the same target, and a publisher enters the direct view only after its replay
    step completes successfully.
21. Active-overlap accounting carries the worker's path classification, so an
    active legacy publisher cannot subtract or displace opposite-path direct
    queue work for the same target.
22. Server and browser reference deduplication retain path-distinct cards for the
    same target, and revealing an unconsumed hidden wash starts the real tide so
    it cannot disappear silently on the next poll.
23. Concurrent direct and legacy workers for one target remain separate active
    records, counts, and overlap keys instead of newer-path replacement.
24. A disposable `wrangler dev --local` Worker serves a complete `/api/status`
    projection containing both direct and legacy journeys, while `/bay` serves
    the observer-only comparison toggle with `aria-pressed="false"`.
25. Failed exact-review publishers remain classified by their publication path:
    legacy failures stay hidden from the default direct-review view, while failed
    review fences remain visible as normal review outcomes.

## Commands and environment

- Focused Node 24 tests covering workflow shape, prompt/schema policy, exact
  bundles, historical publication, and comment rendering.
- pnpm run check for the repository gate.
- Crabbox using the repository-resolved provider and maintained Node 24 image with
  the maintained proof script and committed receipt.
- Real loopback HTTP requests to a disposable local Wrangler Worker and its
  SQLite-backed Durable Object state; no live GitHub or production queue access.
- Fresh Codex review before commit and again on the committed branch against
  origin/main.

## Evidence

The proof directory will contain the exact script, sanitized transcript, receipt,
and content hashes produced for the final committed head.

## Limits

This change does not delete previously published recordings, rewrite canonical
records, dispatch production workflows, mutate the live queue, or remove the
manual historical-record retraction path. Existing proof-bearing publication
artifacts stay supported while they age out. OpenClaw Bay removes future
automatic proof delay and hides the retired proof/legacy-batch journey path by
default; its comparison switch remains observer-only and adds no action surface.
