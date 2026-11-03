# Truthful Coverage: count observations, identity evidence and legacy facts

Purpose: repository-owned Coverage proof procedure and historical evidence limits.
Checkpoint c18bd6d68a9518a2e7e1459dc92765bee596c2a5 is historical; later
changes require their own source-bound validation and review. This document grants
no deployment or publication authority. Historical receipts below qualify only
their recorded source. The retained legacy-only preview is NOT the positive
producer proof.

## Contract

- Open is a directly witnessed, timestamped GitHub repository count. It remains
  available when identity pagination is bounded or labels/reopen data are absent.
  Missing/stale/future count observations are Unknown, never observed zero.
- Reviewable, live-label exclusions, review categories and Fresh require complete
  identity evidence in the qualified review scope. Complete-category conservation
  remains checked. Counts alone cannot fill missing identity/review slots.
- Eligible policy candidates, public observations of unverified eligibility, and
  archived/fork/alias/history references are explicitly separated. Observations
  are not installation proof or permission to admit a review.
- Fresh checks the recorded completed review/date, PR head and latest observed
  reopen. These fields do NOT prove current issue body/comment semantic freshness.
  Generic updated_at is not treated as semantic source validity.
- Historical corpus Open/Stale and 7d/30d review statistics never become current
  live denominators. Closed ghost records cannot supply live reviews/exclusions.

## Bounded producer and automatic legacy fact owner

The existing target-fanout producer retains serial limits:25queries,10pages per
issue/PR connection,20k identities and1.9MB inventory payload. First pages are
batched by10 to bound nested label nodes. A1001-item connection stops at10pages
but retains its separately trusted count witness; no cap/rate/concurrency tune
is used to make large repositories appear complete.

The existing ExactReviewDirectPublicationStore/CanonicalBodyStore owns canonical
body integrity. On coverage read-model refresh it automatically derives missing
or stale-bound v2 coverage facts from already-stored, digest-verified bodies.
Each pass is capped at32objects/4MiB, qualified live identities only. The sole
SQL update is coverage_facts, conditional on the captured digest/revision and
non-deleted row. Facts also carry their source digest/revision and are never
trusted after an older writer changes that revision. No body bytes, placement,
canonical/export revision, timestamp, answer/admission history or tuple receipt
is changed. Failed reads remain unavailable; a bounded negative read cache
prevents a failed prefix monopolizing every subsequent pass. There is no global
migration command, workflow dispatch, new review or tuple publication.

Regression evidence includes: automatic legacy v2 seed->GET->accurate categories
with zero tuple receipts; existing one-review PR recovery without admission
writes; long headers; row/byte caps; concurrent revision/deletion preservation;
old-writer revision recovery; corrupt-body refusal and later-valid-row progress.

## Positive same-bundle post-producer replay

Command after the already-required producer build, inside the approved actual
Crabbox lease with its truthful metadata (see qualification contract below).
Supporting host execution instead requires an explicit --host-supporting flag:

```sh
node docs/proof/ui-live-coverage/post-producer-replay.mjs
```

This uses ONLY the existing frozen November2 21:52UTC public UI/corpus/API capture
and November2 21:53–21:55UTC GitHub response bundle. It is historical replay, NOT a
current November3 fleet observation. Both actual baseline and candidate snapshot/
signed-publication producer stages receive the same count responses. The
candidate additionally runs its actual identity producer against that same
response service, then traverses signed local Worker/DO intake, public API,
actual Astro build, loopback server and Chromium.

The frozen replay evaluates freshness at the captured GitHub bundle completion
time, even when executed days later. Its scoped proof-only Date clock covers
each socket-free local Worker call and BOTH baseline/candidate Astro build
children (explicit --import replay-clock-preload.mjs and
CLAWSWEEPER_PROOF_EVALUATION_AT). It controls Date.now and zero-argument Date,
not native timers, performance/hrtime, socket inactivity expiry or Playwright
timeouts. Parent Date is restored in finally before server/browser work; each
child clock is confined to that build process. Production freshness rules are
unchanged, and no captured count/corpus/GitHub timestamps are rewritten.

New executions record controlled evaluationAt separately from real
executionStartedAt and executionCompletedAt, and add a FROZEN INPUT REPLAY
caption to both new UI captures. Existing historical captures/receipts remain
unchanged.
The browser retains REAL time, so its snapshot-age/refresh banner still ages the
old snapshot; the caption explicitly says this is not a newly observed
production outage. Captioned rendered HTML is retained separately from untouched
built site HTML. The accepted local r3 review finding was that an otherwise
valid replay expired after12hours; three-day regressions now exercise the actual
Worker and child production UI consumer, failure restoration and real timer/
socket expiry. These focused tests do not replace the final contained Astro/UI
proof and fresh review required for changed proof inputs.

Captured node fields are number/updatedAt and PR headRefOid. Labels and latest
reopen timeline fields were NOT captured. They remain absent: no empty labels,
no fake timelineItems.nodes=[], and no invented canonical review statuses. The
producer explicitly reports missing identity fields while retaining witnessed
Open counts. Individual real canonical rows/bodies were not captured either;
that dependency refuses reads rather than treating an empty fixture DB as
evidence every real item is unreviewed.

The positive candidate visibly renders OCM7 and CodexBar98 Open, plus all137
row comparisons and fleet Open8826 at the retained count timestamps. Main and
Enterprise identity drift remains explicit; their Open values are as-of reported
counts, not claimed complete censuses. Inactive/alias references are separate.
The normal observed rows have unverified active eligibility because owner
inventory/default-branch/hasIssuesEnabled/App-installation evidence is absent.

Baseline category values use the genuinely captured legacy public aggregate,
not fabricated per-record statuses. Thus the rebuilt baseline uses captured
API43.0% with its own timestamp; the original deployed43.1% page is preserved
separately. Baseline canonical categories cannot be independently reconstructed
without the uncaptured canonical source. The source-bound receipt states this
limit and identifies the actual production functions exercised.

Artifacts: .artifacts/ui-live-coverage/post-producer-comparison contains
all-137 JSON/CSV, fleet KPI/API JSON, producer inventories, request/response
hashes, input/source bindings, baseline/candidate HTML, standard/all-row PNGs,
browser trace and comparison.md. legacy-only-preview preserves the earlier
negative compatibility demonstration without calling it corrected production.

## Controlled numeric and migration proof

```sh
node docs/proof/ui-live-coverage/run-proof.mjs
```

This separately exercises the actual pinned baseline Worker versus candidate
with identical explicitly synthetic canonical bodies/census inputs. One matching
identity among3 changes100% to33.3%;721stored/453old versus7live changes the
old Worker100% and old UI721/453/37% to Open7/Fresh14.3%. These percentages are
synthetic fixture behavior, NOT real OCM/Enterprise/CodexBar freshness values.
The corrected legacy-fact fixture seeds existing bodies/v2 rows with NULL facts,
then coverage GET automatically derives accurate categories with no new tuple.

Historical November2 attempt: the22:54 Gateway restart interrupted only browser
navigation after successful
Worker assertions and all6Astro builds. Retained outputs are preserved.
resume-browser-proof.mjs resumes only that unfinished phase after checking no
production source changed since the retained observation; it does not rerun
completed Worker/build work. Its continuation receipt explicitly records lost
in-memory SQL detail rather than reconstructing fake row-count evidence. This
historical continuation must not be used after source changes or presented as
validation of later corrections. A complete contained run subsequently passed
for checkpoint c18bd6d; neither result qualifies later source changes.

## Accepted early-review P2: one-fetch build cadence

The strict consumer correctly rejects scans older than15minutes. Returning an
expired cache while refreshing only in background made a15-minute static build
that fetches once potentially publish Unknown every cycle. This accepted
regression is fixed in the owning read path, not dismissed as preexisting.
An expired/missing/future cache now awaits the same coalesced refresh, with a
5-second read-wait bound. Page-yield fairness and work/rate caps are unchanged.
Failure/timeout returns explicit absent scan evidence, not stale categories
with a new timestamp; independent trusted count witnesses remain available.

Deterministic regressions cover15m+1, exactly one fetch per consumer cycle,
changed canonical source (so relabeling stale counts cannot pass), concurrent
waiter coalescing, responsive stats/heartbeat validation, failure and timeout.
refresh-cadence-proof.mjs separately traverses signed local Worker/DO/API and
an actual Astro/browser build. It uses controlled synthetic clocks and a REAL
5-second timeout; no live calls. Artifacts are under
.artifacts/ui-live-coverage/refresh-cadence.

The early Codex pass that identified this P2 was not clean. The parent later
recorded clean precommit and whole-branch native Codex/shared-helper reviews for
c18bd6d. Subsequent full-check findings are accepted candidate work: current
corrections change those review inputs and require fresh review. No earlier
clean result is used to certify the new source.

## Qualification / source binding / current gates

Martin explicitly approved Podman-backed Crabbox local-container on November3
2026 at00:25UTC. The repository default remains AWS; this explicit authorization
permits the isolated proof override, not persistent config or production changes.
Use the Crabbox wrapper with explicit --provider local-container and
--local-container-runtime /usr/bin/podman on acquisition and every lease command.
Use Node>=24, pinned pnpm12.15.0, bounded resources, neutral/tmp and jq for the
repository shell fixtures. No host socket/privilege, credential forwarding,
cloud allocation, live workflow dispatch or production auth is needed.

All three current proof entrypoints require either explicit --host-supporting
(supporting only) or actual CRABBOX_PROOF_PROVIDER=local-container,
CRABBOX_PROOF_LEASE and CRABBOX_PROOF_IMAGE metadata from the actual wrapper run.
The shared proof-provenance.mjs labels these as DECLARED metadata and explicitly
does not verify containment. Attach and independently verify the external
wrapper/runtime receipt, run/lease/container/image identity, resource limits,
mounts and cleanup. Environment strings alone never establish isolation. Do not
invent values to pass a script guard. Cadence/replay use the same explicit mode
contract rather than hardcoded host labels on contained executions.

captureProofSource binds pinned base96869eede468afe433994130d62edd50884ef43a
against the entire candidate HEAD, then overlays tracked staged/unstaged and
nonignored untracked reviewed paths. It records HEAD, HEAD Git tree, merge-base,
full committed range, per-effective-file SHA256 hashes, deleted paths as null,
and the whole committed-tree identity/manifest digest and entry count. Symlink
identity is hashed without following it outside the checkout. Ignored private
scratch is not a reviewed-source input. The tracked patch digest is explicitly
scoped; untracked bytes are bound by file hashes. A clean committed branch no
longer gets an empty source binding merely because git diff HEAD is empty.

Historical actual Podman/Crabbox run run_f2a01a11fb25dd0b704ce3162a389a85 on
leasecbx_09593dea683c exercised c18bd6d (Node24.22.1/pnpm12.15.0):14scenarios,
6actual UI builds, cadence and all137frozen replay rows passed. Its image was
node@sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a.
The full pnpm run check FAILED:6679tests,6553pass,104fail,22skip. A focused
jq-equipped follow-up passed representative shell families but reproduced four
candidate failures (two canonical reader parity, closed logging guard, obsolete
Coverage tooltip test owner). Those are now corrected, not waived. Fixing the
first parity mismatch exposed its second inline-NUL fixture: canonical fact
derivation now retains the existing SQLite inline-text NUL boundary, without
reintroducing clipped long-header facts or changing canonical bytes/fences. The full
gate remains unqualified:102explicit failure blocks versus104reported failures
were not silently reconciled;58blocks explicitly mentioned jq. Other failures,
including cursor publication and batch policy_noop/requeue behavior, are not
assumed solved from representative shell passes. Any later qualification must
retain its own source-bound container, full-check and runtime results.

For a revised candidate, inspect/review the stable corrections, create a normal
local checkpoint, and run final committed container proof. Setup must include jq and
first rerun all previously failed file families (CI/dispatch ownership, comment
router throttle/cursor behavior, batch workflow, queue client/maintenance, sweep
and target dispatcher) before another broad full check. Pinpoint any remaining
failure and compare its intended base before expanding source scope. Then repeat
affected behavior/UI proof and whole-branch review for the final committed source.
The offline Git seed must include every local ancestor commit needed from the
final checkpoint through the pinned base, plus their trees/blobs; no GitHub
fetch, credential helper or shared Git config is needed. No source, receipt or
historical preview is rewritten to pretend an old run exercised new code. No deployment, push/PR or live review request is authorized.

The unchanged docs guard inventories indexed paths. For new uncommitted helper
files, static validation may use a separate scratch --info-only candidate index;
actual index stays unchanged and tests never inherit GIT_INDEX_FILE. Keep all
prior failed full logs and source-bound reports; do not weaken scanner/logging
or other safety guards. Source changes require fresh review, not a claim that
historical c18bd6d proof or review remains current.

## Provenance

Adapted Vincent Koc identity work from
https://github.com/openclaw/clawsweeper/pull/2018 at
09924e942c312fae42a58729ce897942e64cd4d7 after full patch/caller/test inspection,
with current canonical v2 ownership and producer/consumer corrections. Inspected
https://github.com/openclaw/clawsweeper/pull/2015 at
bc9e2d78365dbadb536af35b8c5aca995191f824; its unrelated throughput/outcome
changes were not imported. Neither old draft was edited, rebased or published.
The local checkpoint retains required brokemac79 and applicable source credits;
preserve them in any separately authorized later checkpoint. Neither draft was
published by this task. Bay and all operational controls/policies remain untouched.
