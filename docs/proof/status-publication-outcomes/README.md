# Publication Status Proof

Status: active validation recipe. Owner: dashboard status and presentation.
Source: `dashboard/worker.ts`, `dashboard/dashboard-pages.ts`, and the
publication validator in `dashboard/public-observability.ts`.
Baseline: `49446cd30622e642efceb80e1c0347b2602a0117`.
Last verified: September 11, 2026. Exact candidate identity and dirty-patch digest
are recorded by each run, not inferred from this document.
Update when composition, display fields, cache paths or the proof runtime changes.

## Contract

The composed API preserves the dedicated endpoint's full closed publication
contract through cold, durable, fresh and stale paths. The browser retains only
its four displayed fields through fetch, render and localStorage reload.
Explicit zeroes remain zero. Malformed or stripped counts do not imply zero or
a complete collection. Unknown collections are distinct from a null projection.

Run from a task-owned checkout with Node 24+, installed frozen dependencies and
the Chromium build matching `playwright-core` available locally:

```sh
node docs/proof/status-publication-outcomes/run-proof.mjs 49446cd30622e642efceb80e1c0347b2602a0117
```

The runner archives the baseline, starts isolated local previews using the
repository's frozen Wrangler dependency, and compares them with the candidate.
It writes receipts and desktop/mobile PNGs to `.artifacts/status-publication-outcomes/`.
It closes its browsers, process groups and temporary state on success or failure.
The frozen dependency installation may need network; Worker outbound fetch is denied,
browser requests are restricted to the local preview, and production config,
credentials and bindings are not supplied.

Use `--worker-only` for the paired Worker scenarios without browser automation.
Use `--serve-browser` to keep both loopback previews running after those checks;
the runner prints their origins for validation in an existing browser profile.
Stop the runner with SIGINT or SIGTERM after the browser proof. Browser results
from this mode must be recorded separately; the Worker receipt does not claim
browser validation.
An already installed Wrangler can be selected with
`PUBLICATION_PROOF_WRANGLER=/absolute/path/to/wrangler`; its reported version is
recorded in the receipt. The default executable is the frozen dependency in this
checkout, resolved before changing to temporary state.

## Automated harness coverage

- Worker: 28 paired scenarios, 56 runs, including both durable and optional
  edge cache owners. The baseline loses counts and window
  metadata; the candidate matches the dedicated typed endpoint. Lossy edge
  cache values become null. Durable reuse skips external collection.
- Browser: 22 paired scenarios, 44 runs, across desktop and mobile. Corrected
  fixture responses isolate browser ingestion; a separate observed case uses
  the real Worker `/api/status` route. Every fetched case is reloaded with a
  controlled HTTP 503 to exercise localStorage. A separately seeded legacy
  cache reproduces the misleading complete badge.
- `observed-publication-events.json` preserves an already captured public
  aggregate from September 8, 2026 at 06:32:10.270 UTC. It contains no target
  identities. Its 584 direct accepted and 20 batch retryable events are not
  counts of successful reviews or published comments. No fresh production
  read is required for replay.
- `projection_is_null` describes the whole nested API projection;
  `collection_state` separately describes a valid unknown collection.
- Screenshots exercise the actual served HTML and scripts, not a recreated UI.
  Synthetic unavailable sibling sections are expected; no production-health
  or latency claim follows from this proof.

The September 11 refresh separately exercised all 18 paired Worker scenarios
and the existing Chrome profile through the authenticated extension relay.
That browser pass verified observed, zero, mixed, unknown and lossy desktop
inputs, a mobile observed input, and HTTP 503 reload persistence. Its
before/after screenshots contain only the synthetic local dashboard. Further
mobile permutations were interrupted by local relay and preview failures;
they are not claimed as part of that pass.

Bay consumes `/api/status` but its `publicBayStatus` reader does not select this
field. No Bay controls or rendering change is required. Shared privacy/Bay
tests accompany the API and browser regressions.

Named follow-up: `publicationSource` may accept null bucket counts in an
otherwise complete zero-count source. That preexisting server-validator issue
is not changed or certified by this composition repair.

## Status telemetry failure retention

### Workflow observation reconciliation

The dashboard collector selects a single observation per workflow run before
deriving active and completed views. Run attempts take precedence over update
timestamps; equal attempt/timestamp observations prefer completed state, then
retain the first filtered feed. GitHub documents that reruns retain their run ID and advance
their [attempt number](https://docs.github.com/en/actions/reference/workflows-and-actions/variables).

```sh
node docs/proof/status-publication-outcomes/run-proof.mjs 0318620fb1134a8a0f9aadccbc886be05310919e --workflow-observations
```

This paired proof exercises queued-to-running, active-to-completed and
completed-to-rerun transitions with both HTTP response orders: six scenarios,
twelve baseline/candidate runs. It checks fleet counts, operational queue counts
and running age, pipeline states, health sampling, warm-cache reuse and one
SQLite restart per revision.
The receipt is `workflow-observations-summary.json`. The synthetic queue binding
is unavailable, so the proof does not claim healthy queue/Bay composition or a
cause or fix for production request timeouts. The source capsule procedure below
also applies to this mode. Update this recipe when observation selection,
projections or the fixture changes; exact source identities are in each receipt.

### Workflow attempt cache lifecycle

```sh
node docs/proof/status-publication-outcomes/run-proof.mjs d2194cade55ff8c69b669c6f1b87d82bf90cba74 --workflow-attempts
```

This mode retains one real SQLite store across each attempt transition. A
completed first attempt must not hide an active rerun. A selected completed
second attempt must supply its health sample even when the latest endpoint
has already advanced to a third attempt. It checks cold collection, warm reuse
and SQLite restart through `/api/status`, with distinct jobs and outcomes per
attempt. The receipt is `workflow-attempts-summary.json`.

Job requests use GitHub's [attempt-specific endpoint](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt).
The shared job cache is bound to the selected run and attempt; the repository
health aggregate is reusable only for the same completed-attempt sample.
Unbound transient job caches expire normally and are not migrated. Missing
attempt identity reports unavailable telemetry instead of guessing the latest
attempt. Pagination limits, timeouts and retry policy are unchanged.
This proves the cache lifecycle, not the cause or recovery of a production
timeout. The dashboard status owner maintains this recipe; update it when job
binding, health sampling or the fixture changes. Each receipt records its exact
source revisions.

Run the paired cold collection, warm snapshot, health-cache reuse, SQLite
restart, and recovery scenarios without production credentials:

```sh
node docs/proof/status-publication-outcomes/run-proof.mjs 91fb0b1e719356ead3a763026e3519cdd18e7acc --telemetry-failures
```

The native Worker uses its real status route and SQLite owner against an
isolated loopback GitHub fixture. The baseline masks worker-health errors on
cache reuse; the candidate retains the fixed public section code until a new
healthy sample replaces it. Upstream error text must never appear in responses.
The receipt is `telemetry-failures-summary.json` in the existing artifact
directory. This proves failure retention, not the cause or resolution of a
production collection stall. The same source capsule mechanism below applies.

The GitHub cause mode compares the same native status route and SQLite owner
against the baseline that already retained section codes:

```sh
node docs/proof/status-publication-outcomes/run-proof.mjs 1265122ec07d137740c688d90d5bf9538aa03a78 --github-failures
```

Loopback cases cover HTTP 403/429/503, explicit rate-limit headers, stalled
headers and response bodies, a closed connection, invalid JSON, an incomplete
successful census, and an App-token rejection using an ephemeral synthetic key.
The candidate retains bounded cause suffixes without increasing warning counts;
the baseline retains only section codes. Warm reads, one SQLite restart and
healthy replacement are observed through the actual status API. The receipt is
`github-failures-summary.json` in the existing artifact directory. No production
request, credential, permission or timing change is exercised. A global collection
deadline can still return a fallback without publishing these partial causes.

## Status collection lifetime

The lifetime mode compares the frozen pre-repair source against the candidate:

```sh
node docs/proof/status-publication-outcomes/run-proof.mjs 02cd682921ca0c796212319c1a28c9b1e4bfac58 --lifetime
```

It holds a local SQLite-backed StatusStore read or its response body. The
baseline remains pending past 19.5 seconds. The candidate must return the
existing unavailable projection within that boundary, admit no later read,
persist no timeout result, and complete its next healthy refresh. The same
served Dashboard and Bay must display unavailable status and recover on their
ordinary poll (Dashboard: 15 seconds; Bay: 20 seconds) without a reload or substituted browser response.
Publication counts remain intact on recovery. The Dashboard must show
"Status freshness unavailable" on the unavailable response and restore its
timestamp caption on recovery.

A separate candidate case runs the snapshot publication ordering proof below.
It holds the first final StatusStore PUT while a newer healthy response publishes
to the same real SQLite binding. Releasing the old PUT must retain the newer
body and its original timestamp. The receipt records the stored body and actual
HTTP responses with old fresh/stale edge bodies. Unit tests also cover the
optional edge-only path. Publication remains best-effort; the ordering guarantee
applies to the durable owner and subsequent cached reads.
The local runtime does not reproduce the hosted platform's 30-second
post-response cancellation limit.

The recipe uses the same secretless Wrangler transport and local SQLite
binding. It adds one JSON receipt and four PNGs in the existing artifact
directory; retain them for the PR review. This controlled stall proves the
lifetime contract, not which production dependency stalled.

For a raw Crabbox checkout without Git metadata, prepare a bounded capsule in
the verified owning checkout, transfer it through the native Crabbox script
upload, and pass `--capsule /temporary/capsule.json` with `--lifetime`:

```sh
node docs/proof/status-publication-outcomes/run-proof.mjs 02cd682921ca0c796212319c1a28c9b1e4bfac58 --prepare-capsule /temporary/capsule.json
```

The capsule contains only the archived source owners needed by the Worker,
their Git blob and file digests, and the candidate source/proof manifest.
The runner verifies archive bytes and members, baseline file bytes, and
candidate file bytes before execution; it verifies candidate bytes again
before emitting the receipt. It creates no Git history in the isolated box.

## Snapshot publication ordering

Owner: dashboard status publication. Source: `StatusStore` and `statusJson` in
`dashboard/worker.ts`. Baseline: `c9248c60fcfb060e332193bf6fed926758c5f5f7`.
Verified scope: delayed arrivals, equal timestamps, independent scopes, and old
edge bodies. Update when the publication fence or cached-read owner changes.

```sh
node docs/proof/status-publication-outcomes/run-proof.mjs c9248c60fcfb060e332193bf6fed926758c5f5f7 --publication-order
```

The existing preview fixture delays A before the real SQLite-backed owner,
accepts newer B, then releases A. The baseline rolls back to A; the candidate
retains B. Actual `/api/status` reads retain B even with older fresh/stale edge
bodies. Equal timestamps retain the first accepted body; another scope remains
independent. The receipt is `publication-order-summary.json` in the existing
artifact directory. This proof does not attribute production telemetry failures,
order overlapping HTTP responses, or cover regional clock skew.

Use `--cache-paths` with the same baseline to verify all 18 existing cold,
durable, fresh, and stale publication scenarios against both cache owners,
without requiring the older publication-loss regression or browser automation.
Ten additional warm cases exercise the optional edge owner with no durable
binding: 28 paired scenarios, 56 runs in total. Warm durable fixtures seed both
cache owners. The candidate serves a fresh durable
snapshot directly; the baseline warms its edge cache from that body.


## Publication failure reasons

Owner: publication telemetry. Source: `ExactReviewLifecycleTelemetryStore`, queue
completion and the dedicated public publication aggregate. Baseline:
`76085db0243085d4bcbddc36001ab47ed28ba357`. Update when completion reason codes,
telemetry schema or the public projection changes. Status: active proof recipe.
Last verified: 2026-10-16 against the baseline above; the source capsule records
and verifies the candidate source bytes.

```sh
node docs/proof/status-publication-outcomes/run-proof.mjs 76085db0243085d4bcbddc36001ab47ed28ba357 --publication-reasons
```

The isolated Workerd preview seeds an old SQLite table, completes real batch
and non-batch queue leases, replays both completion routes and restarts the
preview against the same SQLite files. The candidate retains reasons and an
explicit unrecorded count for old rows; the baseline loses the reasons. The
public response contains only the closed aggregate vocabulary. The receipt is
`publication-reasons-summary.json`. This does not certify browser rendering,
composed-cache behavior or a cause for production publication failures.
