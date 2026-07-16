# Live Dashboard

Read when changing the Cloudflare status dashboard, status ingest contract, or
operator-facing ClawSweeper observability.

The live dashboard is phase-one observability only. ClawSweeper still owns
review, repair, apply, merge, comments, labels, and all GitHub mutations. The
Cloudflare Worker reads public GitHub workflow state, serves a compact pipeline
view, exposes live worker/job drill-down, and optionally accepts signed status
events from workflows.

For the end-to-end relationship between GitHub Actions workers, durable jobs,
CrabFleet action sessions, Codex steering, completion reasons, and dashboard
rows, see
[`steerable-repair-automation.md`](steerable-repair-automation.md).

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

The intended reader policy is Cloudflare Access with GitHub login restricted to
the `openclaw` organization. The dashboard Worker does not implement GitHub
OAuth itself. Keep auth at the Cloudflare edge.

The current local Services token can identify the account, but cannot deploy the
Worker or edit Cloudflare Access/DNS. Add the Workers deploy secret, the
`openclaw.ai` routes, and the Access policy after the Services token has Workers
Scripts edit, Zone DNS/route, and Zero Trust Access permissions.

Workflow events are sent with a bearer secret without a browser login. Ingest
requires the `INGEST_TOKEN` Worker secret. If the optional `STATUS_STORE` KV
binding exists, events and CI status use KV. Without KV, the Worker falls back
to Cloudflare edge cache so badges stay fast but less durable across colos.

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

- active ClawSweeper workflow runs
- active Codex jobs, their current GitHub Actions step, elapsed time, target,
  lane, and complete step timeline
- separate issue-to-PR and PR-repair worker filters, with issue or pull request
  links chosen from the work kind
- a Live terminals link to CrabFleet, where registered `github_actions`
  sessions expose the current Codex thread for browser steering
- a five-stage system overview from intake through results
- an Automatic Builds overview grouped by source issue, showing the issue
  title, queued/planning/building/completed/blocked phase, linked Actions run,
  active worker, generated PR, and a chronological lifecycle drawer
- a budget-sized capacity rail plus lane filters for issue-to-PR, PR repair,
  review, repair, commit, assist, and other workers
- queued/waiting run count
- operational health derived from queue age and running age: queued runs become
  degraded after 30 minutes, and in-progress runs become stalled after 150
  minutes
- 24-hour and seven-day health trends for total queue depth, over-age queue
  depth, and the oldest queued/running ages
- job-level worker attempt error rate, recovery rate, and unresolved failures,
  including failures hidden by workflow `continue-on-error`
- automerge worker reliability from the dedicated repair workflow, including
  sampled failure rate, average and longest runtime, active or stalled attempts,
  and the latest failure per target marked as unresolved or recovered by a later
  successful run
- active pipeline rows grouped as automerge, repair, exact review, hot review,
  apply, commit review, or background review
- CI state for active PR rows when available
- recent automerge command-to-merge timing samples
- explicit workflow status events posted to the ingest API when KV ingest is
  enabled
- problem-focused pruning alerts from latest sweep status files when apply runs
  report blocked or degraded progress, with reason tooltips and maintainer
  workflow commands for safe follow-up
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

The Worker fetches job details only for the bounded active-run set, limits that
GitHub fanout to 12 concurrent requests, and caches each run's jobs for 60
seconds. It separately samples 20 recent completed worker runs with ten-way
fanout and caches error/recovery telemetry for 120 seconds. This bounds
telemetry pressure without exceeding the 128-worker fleet budget. Worker details
paginate up to 300 jobs per workflow run so 89-shard runs remain fully visible,
then finish before optional pipeline CI and historical
enrichment begin, so those secondary lookups do not compete with active worker
telemetry. If GitHub job telemetry is unavailable, the API and UI retain the
workflow-level fallback rather than hiding active work.

Automatic issue-build lifecycle events are retained for seven days so completed
and blocked work remains visible after the worker leaves the active Actions
set. Other recent activity remains bounded independently.

Status responses use stale-while-revalidate delivery. After the 20-second fresh
window expires, the Worker immediately returns the last good snapshot, marks it
with `X-ClawSweeper-Cache: stale`, and coalesces one background refresh per
isolate. Recent automerge timing and the latest 100 runs from
`repair-cluster-worker.yml` are cached for five minutes, as are recent
ClawSweeper-owned closes, because those historical sections do not need
worker-step freshness. Reliability sampling filters those workflow runs to
`automerge repair` titles, so failures remain visible even when a worker exits
before publishing a status event. The deployment smoke output includes cache
state, fetch time, and current diagnostics.

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

Each lane renders one signed speed value and curve: successfully completed work
minus newly incoming work, expressed per hour. Positive speed means the lane is
catching up, negative speed means it is falling behind, and zero is balanced.
Incoming counts newly created queue work units; review demand also includes
shed recovery work. Pending merges, delivery replays, retries, and source-drift
requeues do not create new demand. Completed work is counted only when a
successful item actually leaves its lane, in the same queue storage transaction
as the deletion.

After two continuous samples roughly five minutes apart, the dashboard scales
the observed net change to an hourly rate and labels it provisional with the
actual window length. Once an hour of continuous counters exists, it uses a
trailing hourly rate. Zero incoming or zero completed work remains valid data. A
gap over 12 minutes, a cumulative counter reset, or a legacy sample without flow
counters starts a new speed segment; a latest speed point older than 12 minutes
is stale.
Pre-deployment counter history cannot be backfilled, so the first provisional
speed appears about five minutes after deployment.

Operational health remains a current-snapshot alert rather than a historical
chart. `/api/status` classifies the already-fetched active workflow runs as:

- `healthy`: complete telemetry and no over-age runs;
- `degraded`: at least one queued run is 30 minutes old;
- `stalled`: at least one in-progress run is 150 minutes old;
- `unknown`: one or more actionable-status reads failed.

Healthy status stays hidden. A queued run over 30 minutes, an in-progress run
over 150 minutes, or incomplete Actions telemetry opens the expandable “Work
execution needs attention” alert. This live diagnostic reuses the status
snapshot's Actions reads; the history cron no longer stores queue pressure or
oldest-run values.

## Boundaries

Do not move these into the dashboard:

- maintainer authorization
- PR branch writes
- labels/comments/closes/merges
- final merge safety gates

The dashboard Worker owns durable exact-review admission only: it deduplicates
webhook deliveries, coalesces each repository/item pair, and leases at most
64 Actions executors, with up to 60 active leases per target repository. It does
not decide review outcomes or perform target repository mutations. For
command-triggered reviews, the queue retains the bounded review prompt and
command-status identifiers so the leased GitHub Actions executor can update the
original acknowledgement through completion. GitHub Actions remains the
executor and the existing review/apply safety model remains unchanged.

The singleton Durable Object stores each delivery receipt and queue item in its
own SQLite row. Receipt insertion and item coalescing commit in one transaction,
so a crash cannot record a duplicate-suppression receipt without its queued
work. Receipts retain the seven-day idempotency window and expire through the
indexed timestamp path in bounded batches; `/api/exact-review-queue` reports
`delivery_receipts`, `storage_schema_version`, and
`legacy_rollback_available` for operational proof. On the first upgraded
request, the Worker transactionally imports the former `exact-review-queue`
value. For 24 hours it maintains a generation-marked legacy shadow containing
the queue and the complete active seven-day receipt set. Receipt timestamps are
translated by two days so the immediately previous Worker's five-day pruner
preserves their original seven-day expiry, and the reserved generation marker
cannot expire. SQL state, its generation, and the synchronous KV shadow update
in one SQLite transaction, so no committed generation can leave an older shadow
readable. A later re-upgrade uses the generation plus deterministic timestamp
translation to distinguish unchanged shadow receipts from receipts accepted or
refreshed by the rolled-back Worker. It imports authoritative queue and receipt
changes; a surviving generation is reconciled before deletion even when the
rollback outlives the ordinary window. A divergent stale generation fails
closed instead of discarding either side.

The Worker publishes that compatibility shadow only when the complete active
set stays within 20,000 receipts and 1 MiB. If it cannot publish the complete
shadow, it deletes any stale copy, reports rollback unavailable, and keeps the
normalized queue serving; it never emits a lossy rollback state or retries the
oversized write. The rollback bridge therefore cannot recreate the normalized
queue's intake failure.

Before each dispatch batch, the queue reads the `sweep.yml` workflow state once.
If the workflow is disabled, or GitHub cannot confirm its state, due items stay
pending and retry after `EXACT_REVIEW_WORKFLOW_PAUSED_RETRY_MS` (60 seconds by
default). `/api/exact-review-queue` exposes the bounded dispatcher state, reason,
workflow state, check time, and retry time so an intentional pause cannot look
like occupied executor capacity. Re-enabling the workflow does not require a
queue mutation; the next status check resumes normal admission.

The same endpoint exposes `handoff_health` plus oldest timestamps and ages for
the pending, dispatching, and leased phases. New dispatch and claim transitions
carry explicit phase timestamps. Rows written by an older deployment derive
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
so handoff recovery stays live. If the optional queue read fails, it reports
`exact_review_queue: null` and `diagnostics.exact_review_queue_error` without
making the otherwise-current fleet snapshot eligible for stale fallback.

For capacity displays, `/api/exact-review-queue` also exposes compatible
`lanes.review` and `lanes.publication` objects. Each lane reports its own
pending, ready, backoff, dispatching, leased, capacity, active, available-slot,
oldest-pending, and next-attempt values. The existing top-level aggregate fields
remain available for older consumers. Both lanes additionally report
`enqueued_total` and `completed_total`; the review lane's existing
`shed_since_reset` supplies overload demand. Publication also exposes
`capacity_control` with the adaptive base, maximum, current ceiling, cooldown,
recovery progress, and last classified GitHub pressure failure. `/api/status` retains its
`control_plane` compatibility field, but the dashboard no longer renders that
low-actionability section.

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
