# Truthful Coverage: count observations, identity evidence and legacy facts

Status: uncommitted candidate; no deployment/publication authority. The original
legacy-only preview is retained and is NOT the positive post-producer proof.

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

Command after the already-required producer build:

```sh
node docs/proof/ui-live-coverage/post-producer-replay.mjs
```

This uses ONLY the existing frozen21:52 public UI/corpus/API capture and
21:53–21:55 GitHub response bundle. Both actual baseline and candidate snapshot/
signed-publication producer stages receive the same count responses. The
candidate additionally runs its actual identity producer against that same
response service, then traverses signed local Worker/DO intake, public API,
actual Astro build, loopback server and Chromium.

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
node docs/proof/ui-live-coverage/run-proof.mjs --host-supporting
```

This separately exercises the actual pinned baseline Worker versus candidate
with identical explicitly synthetic canonical bodies/census inputs. One matching
identity among3 changes100% to33.3%;721stored/453old versus7live changes the
old Worker100% and old UI721/453/37% to Open7/Fresh14.3%. These percentages are
synthetic fixture behavior, NOT real OCM/Enterprise/CodexBar freshness values.
The corrected legacy-fact fixture seeds existing bodies/v2 rows with NULL facts,
then coverage GET automatically derives accurate categories with no new tuple.

The22:54 Gateway restart interrupted only browser navigation after successful
Worker assertions and all6Astro builds. Retained outputs are preserved.
resume-browser-proof.mjs resumes only that unfinished phase after checking no
production source changed since the retained observation; it does not rerun
completed Worker/build work. Its continuation receipt explicitly records lost
in-memory SQL detail rather than reconstructing fake row-count evidence.

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

The prior early Codex pass produced this finding and was NOT clean. This fix
invalidates that pass; a fresh independent review is required after source freeze.
The retained browser-resume receipt remains historical; the changed production
read path must be re-exercised rather than claiming the old receipt still qualifies.

## Qualification / review hold

Use Node>=24 and the admitted Crabbox provider from THIS worktree. The repository
resolves AWS. Parent verified Podman is present/functional and Crabbox supports
--local-container-runtime; Martin has not yet approved the explicit provider
change. No provider/config/lease action is authorized by a Gateway restart.
All host results are supporting-only, not qualified container proof. A later
local-container run must retain the actual wrapper/provider/runtime/image/lease
receipt; proof environment fields alone are metadata, not containment proof.

The unchanged docs guard inventories indexed paths. For this no-commit task,
static validation can use a separate scratch --info-only candidate index with
actual file hashes; the actual index stays unchanged. Tests do not inherit it.
Full-check failures from the prior workspace-temp layout are retained honestly
and never treated as a clean result. Do not weaken scanner trust guards.

Sources must pause at a stable candidate before the parent independently uses
the available CodexCLI/shared AutoReview helper. No committed-branch review has
completed; no commit/push/PR/re-review/deploy/production operation is authorized.

## Provenance

Adapted Vincent Koc identity work from
https://github.com/openclaw/clawsweeper/pull/2018 at
09924e942c312fae42a58729ce897942e64cd4d7 after full patch/caller/test inspection,
with current canonical v2 ownership and producer/consumer corrections. Inspected
https://github.com/openclaw/clawsweeper/pull/2015 at
bc9e2d78365dbadb536af35b8c5aca995191f824; its unrelated throughput/outcome
changes were not imported. Neither old draft was edited, rebased or published.
Preserve required brokemac79 and applicable source credits in any later
separately authorized commit; none is made here. Bay and all operational
controls/policies remain untouched.
