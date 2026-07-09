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

When a change updates both the Worker and a GitHub Actions workflow that calls
a new Worker route, deploy the reviewed Worker branch first and wait for the
dashboard workflow to pass. Then merge the workflow change. This avoids a
window where Actions sends events to a route that production has not deployed:

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
- job-level worker attempt error rate, recovery rate, and unresolved failures,
  including failures hidden by workflow `continue-on-error`
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
isolate. Recent automerge timing is cached for five minutes and recent
ClawSweeper-owned closes for five minutes because those historical sections do
not need worker-step freshness. The deployment smoke output includes cache
state, fetch time, and current diagnostics.

## Boundaries

Do not move these into the dashboard:

- maintainer authorization
- PR branch writes
- labels/comments/closes/merges
- final merge safety gates

The dashboard Worker owns durable exact-review admission only: it deduplicates
webhook deliveries, coalesces each repository/item pair, and leases at most
28 Actions executors, with up to 24 active leases per target repository. It does
not decide review outcomes or perform target repository mutations. For
command-triggered reviews, the queue retains the bounded review prompt and
command-status identifiers so the leased GitHub Actions executor can update the
original acknowledgement through completion. GitHub Actions remains the
executor and the existing review/apply safety model remains unchanged.

Before each dispatch batch, the queue reads the `sweep.yml` workflow state once.
If the workflow is disabled, or GitHub cannot confirm its state, due items stay
pending and retry after `EXACT_REVIEW_WORKFLOW_PAUSED_RETRY_MS` (60 seconds by
default). `/api/exact-review-queue` exposes the bounded dispatcher state, reason,
workflow state, check time, and retry time so an intentional pause cannot look
like occupied executor capacity. Re-enabling the workflow does not require a
queue mutation; the next status check resumes normal admission.
