# Live Dashboard

- Status: active observer and operator reference
- Owner: ClawSweeper maintainers and the designated Cloudflare operator
- Source of truth: `dashboard/worker.ts`, `dashboard/exact-review-queue.ts`,
  `dashboard/wrangler.toml`, dashboard tests, and deployed read-only endpoints
- Last verified: `openclaw/clawsweeper@647503ec44b8e777dd172adf974a945367da0d19`
- Update when: routes, public fields, queue projections, capacity, alerts,
  deployment, or state-writer telemetry changes

Read when changing the Cloudflare status dashboard, status ingest contract, or
operator-facing ClawSweeper observability.

The live dashboard is observer-only. ClawSweeper still owns review, repair,
apply, merge, comments, labels, and all GitHub mutations. The Cloudflare Worker
reads GitHub workflow state, projects it into closed status and Bay views, and
optionally accepts signed status events from workflows. The one identity
exception is a bounded reference sample containing canonical repository and
issue or pull-request numbers from the explicit verified-public
`PUBLIC_BAY_REPOS` allowlist. Bay and Overview use that same sample for cards
and search; clicking a card opens a local blade with the closed stage/source,
canonical repository and issue/PR links, and, when available, canonical GitHub
run/job links plus fixed action-step categories and states. Public responses
still exclude workflow, item, and step titles, raw or source URLs, queries, raw
failure keys and payloads, internal opaque keys, credentials, tokens, private
or non-allowlisted repositories, and per-job diagnostic text.

For the end-to-end relationship between GitHub Actions workers, durable jobs,
CrabFleet action sessions, Codex steering, completion reasons, and dashboard
rows, see
[`steerable-repair-automation.md`](steerable-repair-automation.md).

Queue transport failures keep the fixed public `exact_review_queue_unavailable`
response. Server logs for `exact_review_queue_request_failed` retain only the
Cloudflare `remote`, `retryable`, and `overloaded` boolean flags; exception text,
stacks, request payloads, and credentials are excluded. These flags are diagnostic
signals and do not change retry or publication policy. Inside the Durable Object,
`exact_review_queue_handler_failed` additionally records `initialize` or `fetch`
and the first numeric `[line, column]` location in the deployed `worker.js` module
(or `null` when unavailable). Match coordinates to that deployment’s bundle;
remote transport replaces the original stack before the outer Worker sees it.
These logs exclude error messages, SQL, private paths, and raw stacks.

## Deployment

Cloudflare account:

- account: `Services@openclaw.org`
- account id: `91b59577e757131d68d55a471fe32aca`
- zone: `openclaw.ai`

Worker:

- name: `clawsweeper-status`
- current deployment: `https://clawsweeper.openclaw.ai/`
- fallback workers.dev deployment: `https://clawsweeper-status.services-91b.workers.dev/`
- machine ingest: `https://clawsweeper.openclaw.ai/api/events`

Deploy with the OpenClaw Cloudflare token:

```bash
source ~/.profile
CLOUDFLARE_ACCOUNT_ID="$OPENCLAW_CLOUDFLARE_ACCOUNT_ID" \
CLOUDFLARE_API_TOKEN="$OPENCLAW_CLOUDFLARE_API_TOKEN" \
pnpm run dashboard:deploy
```

GitHub deploys use `.github/workflows/dashboard.yml`. Configure either
`OPENCLAW_CLOUDFLARE_WORKERS_API_TOKEN` or `OPENCLAW_CLOUDFLARE_API_TOKEN` with
Workers Scripts edit permission before enabling the workflow as the production
deploy path. The deploy workflow injects the `CLAWSWEEPER_STATUS_INGEST_TOKEN`
GitHub secret into a temporary Wrangler config as the Worker `INGEST_TOKEN`.
Its smoke test also verifies the durable exact-review queue binding, not only
the dashboard response.

When a change updates both the Worker and a GitHub Actions workflow, keep the
cross-component protocol compatible in both deployment orders. The exact-review
v2 rollout dispatches the immutable lease tuple under `queue_claim` plus a bounded v1 snapshot; the
Worker accepts v1 claims/finalizers while the workflow can consume either v1 or
v2 claim responses. Deploying the reviewed Worker first remains the preferred
order, but this rollout does not require disabling or draining ClawSweeper:

```bash
gh workflow run dashboard.yml --repo openclaw/clawsweeper --ref <reviewed-branch>
gh api "repos/openclaw/clawsweeper/actions/workflows/dashboard.yml/runs?per_page=1" \
  --jq '.workflow_runs[0] | {id, status, conclusion, html_url}'
```

## Access Model

The intended browser reader policy is Cloudflare Access with GitHub login
restricted to the `openclaw` organization. The dashboard Worker does not
implement GitHub OAuth itself. Keep auth at the Cloudflare edge, but do not use
Access as the privacy boundary: every public status and observability response
must remain safe when treated as public.

The current local Services token can identify the account, but cannot deploy the
Worker or edit Cloudflare Access/DNS. Add the Workers deploy secret, the
`openclaw.ai` routes, and the Access policy after the Services token has Workers
Scripts edit, Zone DNS/route, and Zero Trust Access permissions.

Workflow events are sent with a bearer secret without a browser login. Ingest
requires the `INGEST_TOKEN` Worker secret. Events and CI status persist only
through the private `STATUS_STORE` binding. If that binding is absent, ingest
remains available but the Worker deliberately skips persistence; raw event and
item metadata never falls back to the shared edge cache.

```bash
curl -X POST https://clawsweeper.openclaw.ai/api/events \
  -H "Authorization: Bearer $CLAWSWEEPER_STATUS_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"event_type":"status.test","mode":"e2e","stage":"probe","status":"ok"}'
```

## CI Status

The dashboard does not fan out from the browser to GitHub check APIs. Active
pipeline rows use the ClawSweeper workflow run status as an immediate fallback,
then `.github/workflows/dashboard-ci.yml` refreshes target pull request check
state and posts compact `ci.status` events into KV:

```bash
CLAWSWEEPER_STATUS_URL=https://clawsweeper.openclaw.ai \
CLAWSWEEPER_STATUS_INGEST_TOKEN=... \
GITHUB_TOKEN=... \
pnpm run dashboard:refresh-ci
```

The UI renders `run pending/green/red` until stored target checks arrive, then
switches to `checks pending/green/red` with failing/pending/total counts. CI
snapshots expire after two hours so old PR head state does not stick to fresh
pipeline rows. Production also enables a bounded live fallback for the first
few active PR rows so visible rows do not remain on workflow-only status when KV
is absent or a cache event lands in another Cloudflare colo.

## What It Shows

- bounded active-work counts and closed workflow, worker, status, stage, and
  outcome categories; arbitrary titles, targets, source links, keys, and job
  text are omitted
- six aggregate Bay stages from arrival through repair, split into disjoint
  queued and live counts only when both producer censuses are complete, plus a
  bounded verified-public repository/item/action reference sample used by Bay
  and Overview cards, search, overflow lists, and client-side public-reference
  blades; sampled queue and live references may additionally carry one
  validated queue-start or public action-start clock with its closed kind
- durable lifecycle inventory and six closed lane counts plus at most 24
  minimal cards for verified-public repository/item references
- a budget-sized capacity rail plus aggregate counts for issue-to-PR, PR repair,
  review, repair, commit, assist, and other worker classes
- queued and waiting run counts
- operational health derived from queue age and running age: queued runs from
  30 through 1440 minutes old degrade operational health; queued runs older
  than 1440 minutes are reported separately as zombies; pre-queue pending reruns
  older than 60 minutes are reported separately as wedged; approval-gated runs
  are also reported separately; in-progress runs become stalled after 150 minutes
- 24-hour and seven-day health trends for total queue depth, over-age queue
  depth, and the oldest queued/running ages
- aggregate worker-attempt error, recovery, and unresolved-failure counts,
  including failures hidden by workflow `continue-on-error`
- automerge worker reliability from the dedicated repair workflow, including
  sampled failure rate, average and longest runtime, active or stalled attempts,
  and bounded unresolved or recovered outcome counts
- active pipeline rows grouped as automerge, repair, exact review, hot review,
  apply, or background review
- CI state for active PR rows when available
- global automerge command-to-merge timing buckets and closed terminal outcomes;
  repository, policy, and session rows are not public
- explicit workflow status events posted to the ingest API when KV ingest is
  enabled
- global apply-lane queue, result, lease, and closed failure-category counts;
  repository inventory, run links, and failure text remain private
- lane-level apply health in status JSON so closure processing and durable
  review-comment sync are reported separately even when they share the same
  applicator
- skip next-action buckets in apply health JSON so stale reviews, missing close
  proof, protected labels, stable skips, invalid reports, and open closing PRs
  are discoverable without reading individual item records
- scheduled close-cycle telemetry in apply-health JSON, including current
  apply-ready candidate count and an estimated number of cursor windows to
  revisit the close queue; scheduled cadence time is explanatory only because
  successful windows can dispatch immediate continuations
- fleet-wide review coverage and review-lane health for normalized time ranges;
  repository rows and identifying filters are not public
- exact-review queue backlog, retry-ready backlog, target-admissible backlog,
  fixed backoff and parked reason counts, handoff health, and pressure from the
  current durable queue snapshot
- normal direct-review journeys in the Bay Kanban and one-hour timing metric by
  default, with a presentation-only switch to include the retired automatic
  proof/legacy-batch path for historical comparison

The Worker fetches job details only for the bounded active-run set, limits that
GitHub fanout to 12 concurrent requests, and caches each run's jobs for 60
seconds. It separately samples up to 40 recent completed worker runs with
twenty-way fanout and caches error/recovery telemetry for 120 seconds. That leaves
enough distinct completed-item evidence to drive a 20-outcome tide despite
repeated targets or excluded runs while still bounding telemetry pressure.
This bounds
telemetry pressure without exceeding the 128-worker fleet budget. Worker details
paginate up to 300 jobs per workflow run so 89-shard runs contribute to a
complete internal census. Titles, job names, raw URLs, opaque target keys, and
raw errors are removed before the status snapshot is persisted or returned.
Only the allowlisted canonical repository/item reference tuple and a validated
action descriptor are retained for the bounded Bay sample. The action
descriptor contains canonical repository/run/job identifiers, a canonical
start time, and closed step kind/status/conclusion values; raw step names and
URLs are discarded. If the census is incomplete, the public activity projection
fails closed instead of presenting partial counts as complete.

Automatic issue-build lifecycle events are retained privately for seven days so
completed and blocked work can be reconciled after the worker leaves the active
Actions set. The public lifecycle and recent-publication routes revalidate that
state into bounded inventory, lane, bucket, and outcome counts. Lifecycle may
also return at most 24 minimal cards filtered to `PUBLIC_BAY_REPOS`; it never
returns private repositories, revision identifiers, target keys, facts, titles,
raw URLs, or failure detail.

Status responses use stale-while-revalidate delivery. After the 20-second fresh
window expires, the Worker immediately returns the last good snapshot, marks it
with `X-ClawSweeper-Cache: stale`, and coalesces one background refresh per
isolate. The Worker applies the public status projector before writing fresh or
stale edge-cache bodies and the `StatusStore` snapshot, then applies it again on
every cache/store read. Legacy cache bodies are reprojected, nested or unexpected
fields are dropped, and stale, future-dated, or malformed store documents are
rejected. Diagnostics retain a bounded error count and the fixed
`telemetry_unavailable` category, never upstream exception or API error text.
Recent automerge timing and completed-run samples may still be collected
privately for five minutes, but only their closed aggregate projections enter
the public response.

## Public projection contract

Public observer routes validate a fixed response schema rather than forwarding
their backing store. Unsupported identifying query parameters are ignored; a
malformed or inconsistent backing document fails closed with a fixed
unavailable response.

- `/api/review-observability` returns the four closed review lanes and global
  health, completeness, run counts, item counts, and timestamps for a normalized
  `6h`, `24h`, or `7d` range. It does not return repository filters or labels.
- `/api/review-coverage` returns fleet-wide inventory status and coverage
  totals. Per-repository rows remain in the private queue store.
- `/api/apply-observability` returns global queue, result, retry, lease, and
  closed failure-category counts for a normalized range. It omits repository
  inventories, run links, and failure messages.
- `/api/automerge-metrics` returns global summaries, time buckets, closed
  terminal-outcome counts, and repair-efficiency counts. It omits repository
  and policy filters and every session row; unrecognized terminal outcomes are
  combined into `unknown`.
- `/api/exact-review-queue/item` does not perform a public per-item lookup, and
  `/api/exact-review-queue/reviews` returns a stable empty aggregate envelope.

Rich workflow, queue, item, repository, session, revision, and failure records
may remain in the queue and status Durable Objects when binding-authenticated
workers need them. They must pass through the corresponding public projector
before they reach a public response, edge cache, or ordinary status snapshot.
The projector may retain only the narrow `PUBLIC_BAY_REPOS` reference tuple
described above; this is not permission to expose arbitrary public-repository
metadata or untrusted text.

## Exact Review history

A Cloudflare Cron Trigger records one Exact Review queue sample every five
minutes. It reuses the queue status read that also performs scheduled queue
maintenance and makes no GitHub Actions request. The sample contains each
lane's pending backlog plus cumulative counts for newly enqueued and
successfully completed work. Review samples also retain the cumulative shed
count so overload demand remains visible even when no queue item was admitted.

Samples are stored in the existing `StatusStore` Durable Object under daily UTC
keys named `health-history:YYYY-MM-DD`. Writes replace the current five-minute
slot, making retries and overlapping triggers idempotent. Buckets expire after
the seven-day retention window plus one day of boundary margin. No health
history is written to `openclaw/clawsweeper-state`.

`GET /api/health-history?range=6h` returns the dashboard's default chart range;
`range=24h` and `range=7d` return the longer windows. The endpoint still accepts
and returns legacy operational samples, but new samples omit those unused chart
fields. Existing buckets expire naturally; no migration or manual cleanup is
required.

Each lane renders one signed net-rate value and curve: successfully completed
work minus newly incoming work, expressed per hour. A positive rate means the
lane is catching up, a negative rate means it is falling behind, and zero is
balanced.
Incoming counts newly created queue work units; review demand also includes
shed recovery work. Pending merges, delivery replays, retries, and source-drift
requeues do not create new demand. Completed work is counted only when a
successful item actually leaves its lane, in the same queue storage transaction
as the deletion. A help icon beside each net-rate label exposes this definition
on hover, keyboard focus, or activation; the review explanation explicitly notes
that incoming demand includes shed work.

After two continuous samples roughly five minutes apart, the dashboard scales
the observed net change to an hourly rate and labels it provisional with the
actual window length. Once an hour of continuous counters exists, it uses a
trailing hourly rate. Zero incoming or zero completed work remains valid data. A
gap over 12 minutes, a cumulative counter reset, or a legacy sample without flow
counters starts a new rate segment; a latest rate point older than 12 minutes
is stale.
Pre-deployment counter history cannot be backfilled, so the first provisional
rate appears about five minutes after deployment.

Operational health remains a current-snapshot alert rather than a historical
chart. `/api/status` classifies the already-fetched active workflow runs as:

- `healthy`: complete telemetry and no non-zombie over-age runs;
- `degraded`: at least one queued run is from 30 through 1440 minutes old;
- `stalled`: at least one in-progress run is 150 minutes old;
- `unknown`: one or more actionable-status reads failed.

Webhook workflow snapshots retain a per-run delivery-or-poll confirmation
time. An over-threshold queued run whose confirmation is older than the
five-minute workflow TTL is re-read through the exact GitHub run endpoint
before it can degrade health. One refresh checks at most the ten oldest stale
rows, matching two waves of the five-way request fanout within the 20-second
refresh cadence. Omitted unconfirmed rows cannot contribute to queue pressure
and make health unknown until later refreshes reach them; batch telemetry
records both the selected and omitted counts. Completed or missing runs are
removed from the snapshot and emit structured eviction telemetry; a failed
recheck makes the snapshot unknown. Until `workflow_run` subscription coverage
has actually been observed, repair-fed rows remain unusable and this path uses
the same bounded live status polls as before the webhook read model. Runs beyond
the existing 24-hour zombie boundary remain separately visible and do not spend
exact verification requests.

Healthy status stays hidden. A non-zombie queued run at least 30 minutes old, an
in-progress run at least 150 minutes old, or incomplete Actions telemetry opens the
expandable “Work execution needs attention” alert. This live diagnostic reuses
the status snapshot's Actions reads; the history cron no longer stores queue
pressure or oldest-run values.

Queued runs older than 1440 minutes are reported separately as zombies and do
not contribute to `queued_over_threshold` or `oldest_queued_minutes`; they
therefore do not make an otherwise healthy snapshot degraded. The API exposes
them as `zombie_queued_runs` and `oldest_zombie_queued_minutes`. Runs waiting on
deployment approval are also excluded from queue pressure and exposed as
`approval_gated_runs` and `oldest_approval_gated_minutes`.

Pre-queue pending reruns older than 60 minutes are also excluded from queue
pressure because GitHub cannot cancel or rerun them. The API exposes aggregate
counts and ages only, as `wedged_rerun_runs` and
`oldest_wedged_rerun_minutes`; it does not add run identifiers to the public
status payload.

## Boundaries

Do not move these into the dashboard:

- maintainer authorization
- PR branch writes
- labels/comments/closes/merges
- final merge safety gates

The dashboard Worker owns durable exact-review admission only: it deduplicates
webhook deliveries, coalesces each repository/item pair, and leases at most
128 Actions executors, with up to 120 active leases per target repository. It does
not decide review outcomes or perform target repository mutations. For
command-triggered reviews, the queue retains the bounded review prompt and
command-status identifiers so the leased GitHub Actions executor can update the
original acknowledgement through completion. GitHub Actions remains the
executor and the existing review/apply safety model remains unchanged.

The singleton Durable Object stores each delivery receipt and queue item in its
own SQLite row. Receipt insertion and item coalescing commit in one transaction,
so a crash cannot record a duplicate-suppression receipt without its queued
work. Receipts retain the seven-day idempotency window and expire through the
indexed timestamp path in bounded batches. Delivery receipts, queue items,
storage schema and rollback metadata, item keys, workflow/job metadata,
dispatcher details, credential circuits, and diagnostic records are private
binding-only state. `/api/exact-review-queue` does not serialize them.

On the first upgraded request, the Worker transactionally imports the former
`exact-review-queue` value. For 24 hours it maintains a generation-marked legacy
shadow containing the queue and the complete active seven-day receipt set.
Receipt timestamps are translated by two days so the immediately previous
Worker's five-day pruner preserves their original seven-day expiry, and the
reserved generation marker cannot expire. SQL state, its generation, and the
synchronous KV shadow update in one SQLite transaction, so no committed
generation can leave an older shadow readable. A later re-upgrade uses the
generation plus deterministic timestamp translation to distinguish unchanged
shadow receipts from receipts accepted or refreshed by the rolled-back Worker.
It imports authoritative queue and receipt changes; a surviving generation is
reconciled before deletion even when the rollback outlives the ordinary window.
A divergent stale generation fails closed instead of discarding either side.

The Worker publishes that compatibility shadow only when the complete active
set stays within 20,000 receipts and 1 MiB. If it cannot publish the complete
shadow, it deletes any stale copy, reports rollback unavailable, and keeps the
normalized queue serving; it never emits a lossy rollback state or retries the
oversized write. The rollback bridge therefore cannot recreate the normalized
queue's intake failure.

Before each dispatch batch, the queue reads the `sweep.yml` workflow state once.
If the workflow is disabled, or GitHub cannot confirm its state, due items stay
pending and retry after `EXACT_REVIEW_WORKFLOW_PAUSED_RETRY_MS` (60 seconds by
default). The private queue state retains the dispatcher and workflow check
needed to resume admission. The public queue projection exposes only the closed
handoff status/reason and bounded phase counts and ages; it does not expose raw
dispatcher state, workflow state, check timestamps, or retry detail.
Re-enabling the workflow does not require a queue mutation; the next private
status check resumes normal admission.

Scheduled hot and normal-backfill decisions have already passed the queue's
fleet-wide rate and burst controls, so they skip the webhook-churn debounce and
become ready immediately unless the dispatcher itself is paused or blocked.
Review items parked after retry exhaustion or a permanent dispatch rejection
retry automatically after 5, 10, and 20 minutes. A successful newer decision
resets that recovery budget; after three unsuccessful recovery cycles the item
stays parked for operator inspection. Publication dead-letter-capacity parks
retain their separate operator-controlled recovery path.

Every failed exact-review completion first records one durable, deduplicated
attempt keyed by its claim tuple. The record contains only closed stage/reason,
retryability, source and failure fingerprints, immutable source identifiers,
and workflow coordinates; raw diagnostics and scanner findings are never
stored. The public `review_failure_health` projection groups the last hour into
fixed stage buckets and marks a repeated target/source/failure identity
critical. The dashboard raises recent failures to amber and repeated failures
or exhausted review retries to red. A signed operator inventory provides the
corresponding target and run identities for investigation.

`/api/exact-review-queue` is an explicit, closed aggregate projection. It
contains `generated_at`, `ready_pending`, `admissible_pending`, `pressure`,
`handoff_health`, `review_failure_health`, and bounded counts and oldest timestamps or ages for the
pending, dispatching, and leased phases. `ready_pending` excludes retry-delayed
items. `admissible_pending` further excludes ready items blocked by their
target's exact-review cap. `pressure` is a deterministic observation from that
same queue snapshot: it reports `congested` or `saturated` only when capacity is
full, handoff telemetry is known, and target-admissible backlog remains. The
projection adds no GitHub API fanout, and no workflow, planner, admission,
continuation, or dispatch decision consumes the pressure value. New dispatch
and claim transitions carry explicit phase timestamps. Rows written by an older deployment derive
their phase start from the active dispatch or execution lease; a stale timestamp
left by a rollback cannot override that newer lease, and a wholly unknown legacy
age stays non-alarming. A claim is degraded after one third of the dispatch
lease (bounded to 30-120 seconds) and stalled after two thirds (bounded to
31-300 seconds), so operators see the failure before the lease expires and
requeues. A blocked dispatcher with pending work is stalled; an intentionally
paused dispatcher is degraded. `/api/status` includes this snapshot and the live
dashboard renders the three phases, oldest age, available exact-review slots,
and the current classification without changing queue capacity or storage
schema. Fleet snapshots may use the longer stale fallback during a GitHub API
outage, but `/api/status` attaches queue telemetry after selecting that snapshot
so handoff recovery stays live. If the optional queue read fails or is malformed,
the public response uses an unavailable/unknown aggregate and a bounded
`telemetry_unavailable` diagnostic; it never returns the underlying error text.

For capacity displays, `/api/exact-review-queue` also exposes compatible
`lanes.review` and `lanes.publication` objects. Each lane reports its own
pending, ready, backoff, dispatching, leased, capacity, active, available-slot,
oldest-pending, and next-attempt values. `backoff_reasons` and `parked_reasons`
count the causes represented by those lane totals, and the dashboard renders
the same breakdown beside the lane counts. The existing top-level aggregate
fields remain available for older consumers. Both lanes additionally report
`enqueued_total` and `completed_total`; the review lane's existing
`shed_since_reset` supplies overload demand. The public response omits item
samples, ownership maps, per-target statistics, raw dispatch or failure detail,
adaptive capacity-control internals, and all unexpected fields. A malformed
required count or health value returns an unknown projection with HTTP 503
instead of a plausible empty queue.

Production overrides publication minimum, base, and maximum capacity to 8, 32,
and 40, while source fallback values are 4, 24, and 48. The controller records
failure, cooldown, recovery, and demand telemetry and scales within the
production range. The private publication state also tracks `batches`, `direct`,
and adaptive capacity control: production enables up to 8 concurrent size-8
batches, reserves two fresh-lane members per batch, and enables direct
publication with retry/batch fallback. These controls affect the aggregate
counts but are not serialized by the public projector. Document effective
production values from `dashboard/wrangler.toml`, not only fallback constants
in `dashboard/exact-review-queue.ts`.

Batch publication heartbeats retry network errors, timeouts, and HTTP 5xx
responses (including `exact_review_queue_unavailable`) up to three attempts
within 45 seconds, with at most 20 seconds per attempt. Heartbeat retries
preserve the signed bytes, use jittered exponential backoff, honor `Retry-After`
up to 10 seconds, and stop at the last confirmed server lease expiry.
Validation, authentication, and fence rejections are never retried.

Post-effect enqueue, router-receipt, and terminal-disposition POSTs are
deliberately one-shot until Worker replay ordering is repaired. An ambiguous
failure ends the publication run so scheduled recovery can replay it without an
in-process retry arriving after newer queue state.

Lifecycle receipt replays are no-ops for the whole operation, including terminal
transitions and acknowledgement drivers. Terminal-disposition requests from the
batch workflow carry a stable `operation_id` derived from the run, attempt, and
fence; applied IDs are retained with the lifecycle revision's receipt history.
A replay after a newer requeue preserves that requeue. Older workflows without
an operation ID retain their existing terminal-transition behavior. Failed
queue requests report the HTTP status and, when present, a validated short
server error code; raw response bodies are never included.

Batch claims carrying the current dispatch reservation consume only the
still-valid subset of the key/revision pairs checked before departure. Fresh
arrivals wait for the next departure; changed or removed members are skipped.
An empty subset retires that reservation and requests another preflight.

Only signed intake (`/enqueue`, `/command-intake`, `/branch-authority`,
`/source-authority`) may reuse durable KV public-admission observations;
credential-bearing paths require live probes. `EXACT_REVIEW_HOSTED_TARGET_ADMISSION_FRESH_MS`
(60,000 ms) permits intake without probing; retryable probes allow fallback until
`EXACT_REVIEW_HOSTED_TARGET_ADMISSION_MAX_STALE_MS` (1,800,000 ms; zero disables caching).
Terminal visibility or eligibility revokes admission with a unique token fencing
older probes, including across tombstone expiry. Tombstones expire lazily after
at least 30 minutes; probes outliving retention must retry.

Alarms prune up to `EXACT_REVIEW_STALE_PUBLICATION_PRUNE_LIMIT` stale revisions
(default 100), oldest first, without GitHub reads. Only pending/parked rows without
active batch ownership, terminal finalization or command context qualify;
duplicate-lineage and legacy terminal cleanup remains operator-owned.
Successful queue handoff expires the workflow's review-start lease to permit
another exact-head review; terminal publication still deletes the placeholder.

The binding-only publication state retains additional diagnostics:

- `credential_circuits` records the pool class, optional target owner,
  observation time, raw credential reset as `blocked_until`, latest
  per-member reset-plus-jitter boundary as `recovery_until`, reset source,
  authority flag, active state, and affected pending count. A circuit remains
  active through `recovery_until`; `active: true` with free publication slots
  means credential-blocked, not capacity-starved or healthy-idle.
- `github_request_metrics` contains cumulative counters keyed by pool
  class, endpoint category, operation class, outcome, and whether the item
  revision was already retried.
- `flow.last_15_minutes.causes` and `flow.last_60_minutes.causes` reconcile
  publication retry, backoff, supersession, refresh, and dead-letter exhaustion
  against durable flow counts. The surrounding flow window exposes `refreshed`
  and `refreshed_rate_per_hour` as the independent refresh denominator. Cause
  rows use only closed stage, completion, reason,
  revision-relation, pool-class, recovery-cause, backoff, and attempt buckets.
  `attribution_complete=false` or a failed per-transition `reconciliation`
  explicitly marks a legacy or truncated denominator; the Worker never invents
  attribution for an old aggregate.

Those records are available only through the Durable Object binding and are not
part of `/api/exact-review-queue`, `/api/status`, or Bay. The public projection
keeps useful closed lane totals and fixed reason counts without exposing
credential, target, revision, reset, member, or transition rows.

An unattempted credential-circuit member appears as `transition: backoff` and
does not increment `retried`. A retry-exhausted dead letter preserves the
underlying completion reason in the cause row while the operator-facing dead
letter retains its established `retry_exhausted` reason. A terminal coverage
deferral is reported as `transition: deferred`, never as a publication. When a
batch publishes its owned revision while a newer local revision is already
queued, the ledger records both the completed publication and the follow-on
backoff; the published row still reconciles to the durable publication total.
Cause rows persist privately in SQLite for the same 48-hour window as
publication flow buckets. They are not a public dimension-row surface.

The durable handoff's `handoff_health.recovery_reasons` counts bounded
`claim_timeout`, `execution_timeout`, `workflow_cancelled`, and
`workflow_failed` recovery causes. These are observed queue and workflow facts;
they do not infer why GitHub or a runner cancelled or failed a workflow.

`GET /api/github-egress-observability?hours=6` adds the publication transport
denominator as revision-independent closed aggregate rows. It separates durable
members, `gh` invocations, and observed HTTP wire attempts and retains bounded
pool, method, normalized route, page, source, stage, claim-generation, and
first/repeat categories. Deployment/configuration revisions are withheld and
otherwise-identical rows are combined across them. Private 403/429 observations
become counts by status, pool class, operation, reset-authority category,
resource category, and header presence; raw reset values and observation rows
are not public. See
[GitHub publication egress telemetry](github-egress-telemetry.md) for exact
semantics, retention, privacy, and known opaque boundaries.

Bay renders closed aggregate health context only. Its retired proof/batch
switch filters the already-projected cards and selects between closed timing
aggregates; it does not change queue admission or execution. Bay has no circuit reset,
workflow dispatch, queue retry, replay, acknowledgement, or gate control, and it
does not expose credential circuits or per-member recovery boundaries. Private
circuit state continues to control automatic recovery.

The standalone **State writer** panel separates the repo-wide serialization
boundary from exact-review materialization telemetry. After the coordinator
cutover, `state_writer.coordinator` is authoritative for the active writer,
FIFO queue depth, completed turns, recovery counters, and coordinator wait.
Private state may retain Git lease and revision fences for crash recovery; the
public panel omits them. Exact-review terminal telemetry still owns aggregate
item/commit throughput and fence timing; an idle or failed publisher can make
that telemetry stale without making the coordinator unavailable. The panel
therefore shows bounded queue and throughput counts, uses five-minute
coordinator queue depth for its primary chart, and never renders stale terminal
zeroes as current throughput.

Executors report the GitHub job outcome from their finalizer. Failure or
cancellation clears the lease and requeues the item. Finalizer success remains
provisional because GitHub can still cancel the run or fail a post-action; only
the signed terminal-run backstop removes the item after GitHub confirms the
exact attempt succeeded. A newer revision can requeue immediately. A signed
`POST /internal/exact-review/reconcile` backstop accepts at most 32 exact run IDs
and intersects them with currently claimed leases. The Worker checks those IDs
and attempts with an Actions-read GitHub App token and reconciles only runs
whose immutable GitHub attempt status is `completed`; queued and in-progress
runs remain leased. A per-claim generation check prevents a terminal decision
sampled before a rerun claim from releasing that newer attempt. The request body
is `{ "runs": [{ "run_id": "<run-id>", "run_attempt": 1 }] }`, signed over the
exact bytes with `CLAWSWEEPER_WEBHOOK_SECRET` in
`x-clawsweeper-exact-review-signature: sha256=<hmac>`.

Do not disable or drain the sweep workflow for this protocol rollout. A v2
Worker sends the strict tuple under `queue_claim` plus the immutable v1 event snapshot, accepts
legacy lease-id claims/finalizers only for claims recorded as protocol v1, and
keeps tuple/generation CAS mandatory for protocol v2. A v2 workflow falls back
to the v1 event snapshot only when the claim response identifies or implies a
v1 Worker. Keep this mixed-version coverage until every in-flight v1 dispatch
has drained naturally. The dashboard deployment smoke test must still observe
HTTP 401 from an unsigned reconciliation request; HTTP 404 means the old Worker
is serving that route.
