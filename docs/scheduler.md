# Issue and PR Scheduler

Read when changing `.github/workflows/sweep.yml`, `src/clawsweeper.ts` planner
selection, review cadence, dashboard capacity fields, or GitHub Actions
concurrency for issue/PR review and apply.

The global worker budget comes from `config/automation-limits.json`; see
[Automation Limits](limits.md) for the derived lane limits and GitHub variable
overrides.

Repair and automerge jobs also carry the canonical `job_intent` frontmatter
described in [ClawSweeper Orchestration](orchestration.md). Workflow inputs can
still override live-worker caps, but when they do not, `repair:dispatch` derives
the priority lane from `job_intent` instead of relying on workflow-specific
defaults.

ClawSweeper has three issue/PR scheduler paths:

- exact event review for one target issue or pull request
- hot intake for new or recently active queue edges
- normal backfill for due backlog review

The lanes share report storage and apply rules, but they intentionally do not
share throughput. Event review and hot intake keep new maintainer-visible work
fast. Scheduled normal backfill keeps up to 12 concurrent Codex review shards
when quiet; manual backfill can use up to 22 concurrent Codex review shards.
Normal `openclaw/openclaw` review has an
active floor of 9 shards for scheduled runs and workflow-dispatch
continuations: due items win first, and if fewer than 9 items are due, the
planner fills the floor with the stalest currently-reviewed eligible items so
review capacity stays warm around the clock.

## Workflow

The receiver workflow is `.github/workflows/sweep.yml`.

Important source files:

- `src/clawsweeper.ts`: item selection, cadence, planning, review, dashboard,
  and status JSON
- `config/target-repositories.json`: configured non-core target repositories
  and the conservative `openclaw/*` exact-review fallback
- `docs/target-repositories.md`: target onboarding and rollout checklist
- `src/repair/workflow-utils.ts`: GitHub Actions output shaping for plans
- `results/sweep-status/<repo-slug>.json`: generated state consumed by the
  dashboard
- `records/<repo-slug>/items/<number>.md`: open item reports
- `records/<repo-slug>/closed/<number>.md`: archived closed reports

Generated state is published to the `state` branch of
`openclaw/clawsweeper-state`. Its `main` branch contains dashboard renderer
source only. For local record inspection, switch that checkout to `state` or run
`scripts/hydrate-state.ts` from a `state`-branch checkout before using
`records/`.

The workflow has one concurrency group per lane and target repository. Scheduled
normal review cannot overlap another normal review for the same target repo.
GitHub may keep one pending run for a concurrency group; newer scheduled runs
can replace older pending runs, but they do not cancel a running normal review
because `cancel-in-progress` is only true for exact `repository_dispatch` runs.
Manual exact-item `workflow_dispatch` reviews use an exact-item concurrency
group, so targeted maintainer checks do not wait behind broad normal backfill.

## Schedules

`openclaw/openclaw`:

- hot intake: `*/5 * * * *`
- normal backfill: `1/5 * * * *`
- apply: `3,18,33,48 * * * *`
- audit: `7 */6 * * *`

`openclaw/clawhub`:

- hot intake: `2/5 * * * *`
- normal backfill: `22 * * * *`
- apply: `8,23,38,53 * * * *`
- audit: `12 */6 * * *`
- review and apply work is gated by `CLAWSWEEPER_ENABLE_CLAWHUB=1`

`openclaw/clawsweeper`:

- audit: `17 */6 * * *`
- self-review is primarily manual or event-driven; scheduled audit keeps the
  dashboard health row fresh

Failed Codex review backstop:

- failed-review retry: `13 * * * *`
- retries remain dry-run unless `CLAWSWEEPER_FAILED_REVIEW_RETRY_ENABLED=1`
- each retry is exact-item, cooldown- and attempt-bounded, and complements the
  immediate one-shot failed-shard recovery in the originating workflow

`openclaw/fs-safe`:

- exact event review: enabled through the target repository dispatcher
- scheduled review/apply/audit: not enabled yet
- issues are review/comment-only; PRs may auto-close only when already
  implemented on `main`

Generic `openclaw/*` and `steipete/*` repositories:

- exact event/manual review: supported through configured generic fallbacks after
  the target dispatcher and GitHub App installation are present
- scheduled review/audit: target fanout dispatches small cursor-based batches
  from `target_inventory.owners`
- generic OpenClaw issues are review/comment-only; generic OpenClaw PRs may
  auto-close only when already implemented on the default branch or age-gated
  mostly implemented there
- generic `steipete/*` repositories are review/comment-only for issues and PRs

Manual `workflow_dispatch` can override `target_repo`, `item_number`,
`item_numbers`, `batch_size`, `shard_count`, `hot_intake`, and apply inputs.
Exact item dispatches use a dedicated concurrency group and exact planner
matrix rather than the broad normal-review queue.

Target fanout dispatches review batches through `repository_dispatch` so each
selected repository can carry its inventory default branch without consuming
manual workflow inputs. Scheduled fanout uses:

- hot intake: `4/15 * * * *`, 10 target repositories per cursor step
- normal review: `41 * * * *`, 6 target repositories per cursor step
- audit: `37 */6 * * *`, 12 target repositories per cursor step

Exact event review also starts Codex before generated-state hydration. The
single-item review only needs the target repository and live GitHub item state;
generated state is checked out afterward, just before publishing the review
record, safe close result, and command-router ledger.

## Automerge Fast Path

Automerge is an exact-item event path. A maintainer command dispatches one
review for the current PR head. If review requests a repair, the adopted repair
worker may push a branch fix; after a successful contributor-branch repair it
immediately dispatches another exact-head review and then shepherds the repaired
head for a bounded window instead of exiting immediately. That keeps the normal
path to:

1. command acknowledgement;
2. exact-head review;
3. optional branch repair;
4. immediate exact-head re-review;
5. merge after checks, review verdict, and policy gates pass.

The complete state machine is documented in
[`docs/repair/automerge-flow.md`](repair/automerge-flow.md). Keep this section
as the scheduler-facing summary.

The automerge status comment is the live progress surface. It is edited in
place and records review, repair, re-review, and merge events with durations,
run links, and commit links.

If a no-op automerge repair finds that the PR was already the canonical fix, the
worker does not stop at the observational result. It immediately continues the
state machine: either queueing a fresh exact-head review, or, when the existing
ClawSweeper review only asked a maintainer to land the canonical PR and the
maintainer already opted into automerge, queueing the merge gate for that exact
review comment.

Automerge activation also checks the OpenClaw changelog policy before spending
an exact-head review pass. User-facing `fix`, `feat`, and `perf` PRs that touch
non-doc/test files and do not already include `CHANGELOG.md` go straight to the
adopted repair worker, so the changelog fix happens in the first loop instead
of being discovered only at the final merge gate.

After live hydration, adopted automerge/autofix repairs now skip the read-only
Codex planning pass entirely. The worker emits a generic structured fix
artifact directly: repair the contributor branch, rebase onto current `main`,
address comments/review findings/failing checks, add a changelog entry when
required, and validate. The execute stage still owns all GitHub mutations,
validation authority, push, exact-head review, checks, and merge gating.

For explicit base-sync-only repairs, the repair executor first tries a
deterministic fast path: rebase onto current `main`, apply known mechanical
conflict resolvers such as isolated `CHANGELOG.md` conflicts and generated
config checksum three-way conflicts, push the repaired branch, then wait for
exact-head review and GitHub checks. For substantive automerge repairs, Codex
owns the initial rebase plus PR-comment, CI, and local-test repair loop; the
executor still owns every GitHub mutation and reruns the normalized validation
gate before push. If `main` moves during that final validation, the worker does
one final base sync by default and lets the immediate exact-head review plus
GitHub checks validate the pushed head; `CLAWSWEEPER_FINAL_BASE_SYNC_ATTEMPTS`
can raise that only when extra local passes are intentionally worth the delay.
Likewise, the last internal Codex `/review` is not a dead end: if it still finds
an actionable issue, the worker can run one final review-fix pass, require
changed-surface validation to pass, push the repaired branch, and leave the
immediate exact-head review plus GitHub checks as the merge authority.
The default shepherd wait is ten minutes with 15-second polls, controlled by
`CLAWSWEEPER_AUTOMERGE_SHEPHERD_WAIT_MS` and
`CLAWSWEEPER_AUTOMERGE_SHEPHERD_POLL_MS`. Terminal check failures stop the
shepherd wait immediately and dispatch the router so the failed-check repair
loop can start without waiting for the full timeout.

The final router gate waits up to ten minutes for transient GitHub merge state
or pending required checks, polling every 15 seconds. Pending checks are wait
states, not repair triggers; terminal required-check failures can still dispatch
the adopted repair worker. If GitHub still reports `UNSTABLE`, ClawSweeper
allows the merge command to try when the only visible blockers are ignored
non-gating automation checks such as `ClawSweeper Dispatch`; GitHub branch
protection still enforces required checks at merge time. If the live merge
preflight reports `DIRTY`, `BEHIND`, or `CONFLICTING`, automerge treats that as
repairable rebase work and dispatches the adopted repair worker instead of
leaving the PR open with only a status comment.

## Capacity

Capacity is shard-level. A review shard processes its selected item numbers
sequentially, so maximum concurrent Codex sessions equals the number of nonempty
review shard jobs, not `batch_size * shard_count`.

Capacity also has priority. Exact-item review, repair, automerge repair, and
issue implementation are priority work because they unblock a specific PR,
issue, or maintainer command. Normal review, hot intake, and commit review are
background work because they keep the backlog fresh but can safely slow down
when priority work is busy. The workflow asks the central worker scheduler for a
lane limit before dispatching background work; see
[`docs/limits.md`](limits.md) for the config, formulas, and examples.

Current defaults:

- exact event review: 1 shard, 1 item
- exact manual hot intake: 1 shard, 1 item
- broad hot intake: up to 11 shards when quiet, batch size 1, scans up to 10
  GitHub pages
- scheduled normal backfill: up to 12 shards when quiet, batch size 3, scans up
  to 250 GitHub pages after reserving interactive and expansion capacity
- normal active floor: 9 shards for `openclaw/openclaw` scheduled runs and
  workflow-dispatch continuations; stale current-review backfill is eligible
  after 6 hours
- manual normal backfill: defaults to 22 shards, batch size 3, scans up to 250
  GitHub pages unless overridden, and stops early once scanned due candidates
  fill planned capacity

The hard planner cap is 32 shards. The workflow clamps invalid or larger
`shard_count` inputs to 32.

Broad background review also clamps manual `shard_count` input to the current
lane allowance from `worker-limit`. Pending or planning background sweeps reserve
their quiet lane size until their matrix shards exist, so overlapping manual or
scheduled dispatches cannot temporarily exceed the shared worker budget while
GitHub is still expanding jobs.

Planning is also the runtime build point for matrix review. The plan job installs
with pinned Node 24 and `pnpm@10.33.2`, builds `dist/` once, and uploads that
runtime artifact. Review shards download the built `dist/` and run
`node dist/clawsweeper.js review` directly instead of running a per-shard pnpm
install and build. This keeps 11-22 shard waves from stampeding the npm
registry or Corepack metadata endpoints.

Each review shard also wraps the review command in a shell timeout derived from
the per-item Codex timeout and the shard batch size, with a 70-minute ceiling so
the job still has time to upload metrics and failed-shard artifacts. A hung
review command therefore records a failed shard for the recovery lane instead
of blocking the publish job until the 75-minute GitHub job timeout.

Read-only review shards use shallow ClawSweeper checkouts and skip generated
state checkout entirely. The planner passes exact item numbers to each shard, so
shards can fetch current GitHub item state and write review artifacts without
hydrating historical records. Publish and apply jobs keep full state history
because they may rebase and push generated records.

Normal backfill now runs every 5 minutes for `openclaw/openclaw`. Because its
concurrency group allows only one running normal backfill per target repo, the
effect is a continuous drain loop: when due backlog exists, the active run can
hold up to 12 Codex review shards with up to three items per shard, and the next
scheduled tick is available as the backstop or pending continuation. Manual
normal reviews keep the larger default batch size for targeted catch-up runs.

The quiet-system ceiling is not a promise that every scheduled run dispatches
that many shards. The `mode` step checks active repair workers, exact-item sweep
runs, commit-review pages, and live normal/hot review shard jobs, then asks
`worker-limit normal_review` or `worker-limit hot_intake` for the current
allowance. Planning, publish, queued, and not-yet-expanded background runs
reserve one worker slot instead of a whole quiet-system lane. If
repair/automerge is busy, background sweep dispatches fewer shards and leaves
capacity for the specific work that is closest to a merge or maintainer request.
Background lanes also subtract a 12-worker expansion reserve so independently
planned exact-item and commit-review runs have room to start without pushing the
live Codex count past the global budget.

The active floor is not a separate lane and does not change close/apply safety.
It only changes normal planning when due backlog is below the desired floor:
after selecting all due candidates, the planner fills up to 9 nonempty shards
with eligible items whose latest complete review is at least 6 hours old.
Capacity status reports this as `floor: due backlog below active floor`. If the
central worker scheduler returns fewer than 9 allowed shards, the smaller
worker allowance wins.

On saturated queues, normal planning stops scanning as soon as it has enough due
candidates to fill `batch_size * shard_count`. `dueBacklog` remains the due
backlog found during the scan, not a full-repository count. This keeps
continuation runs from spending minutes on extra GitHub page reads before the
review shard matrix can start.

Optional planning-started and in-progress dashboard publishes in the plan job
are capped at 20 seconds. They are useful telemetry, but they must not delay
candidate selection or the review shard matrix; the publish job writes the final
dashboard state after review artifacts land.

The plan jobs calculate live capacity from the GitHub Actions REST runs list,
normalized to the same fields as `gh run list`. The REST endpoint is used because
`gh run list` can miss active repository-dispatch runs in some local and Actions
contexts, which would make the scheduler undercount active review workers. Every
active status is paginated so fleets above 100 runs remain fully counted.

## Cadence

The planner considers only open issues and PRs that pass `shouldPlanItem`.
Protected labels and other non-reviewable items are skipped before Codex work is
allocated.

Review cadence:

- items with target-side activity since the last real review: hourly
- items created in the last 7 days without new target-side activity: daily
- pull requests outside the hot window: daily
- issues created in the last 30 days: daily
- older inactive issues: weekly
- review policy hash changes: due immediately

The activity check ignores ClawSweeper-owned GitHub mutations that are already
recorded in durable report frontmatter. `review_comment_synced_at` covers public
review comment writes, and `labels_synced_at` covers ClawSweeper label-only
writes such as priority or advisory issue-label syncs. If GitHub `updated_at` is
at or before either marker, the planner does not treat it as fresh reporter or
maintainer activity.

Selection uses weighted buckets so hot issues cannot starve pull requests and
older issue backlog forever. The normal scheduler cycles through:

- hot issues
- hot pull requests
- activity-driven items
- daily pull requests
- recent issues
- weekly older issues

Within each bucket, earlier due times and older reviews win before item number.
Items whose latest complete review, or creation time when never reviewed, is
already more than seven days old are selected first across all buckets. The
weighted mix applies to the remaining capacity, making weekly freshness an
enforced outer SLO instead of only a cadence hint.

## Planning

The plan step runs:

```bash
pnpm run --silent plan -- \
  --target-repo "$TARGET_REPO" \
  --batch-size "$BATCH_SIZE" \
  --max-pages "$MAX_PAGES" \
  --shard-count "$SHARD_COUNT" \
  --codex-model internal \
  --codex-reasoning-effort high \
  --codex-sandbox danger-full-access \
  --min-active-shards "$MIN_ACTIVE_SHARDS" \
  --min-backfill-review-age-minutes "$MIN_BACKFILL_REVIEW_AGE_MINUTES"
```

`pnpm run plan` returns:

- `candidates`: selected open items
- `shards`: selected item numbers distributed across shard jobs
- `capacity`: `batch_size * clamped_shard_count`
- `dueBacklog`: due candidates found during the scan; on saturated queues this
  can be a lower bound because planning stops once capacity is full
- `activeCodexTarget`: nonempty shard count
- `oldestUnreviewedAt`: oldest scanned due candidate with no existing review
- `capacityReason`: why the selected count did or did not fill capacity
- `floorBackfill`: selected stale current-review candidates used to fill the
  active floor
- `matrix`: GitHub Actions matrix entries

`pnpm run workflow -- plan-output` maps that JSON to GitHub Actions outputs:

- `planned_count`
- `planned_capacity`
- `planned_item_numbers`
- `planned_shards`
- `active_codex_target`
- `due_backlog`
- `oldest_unreviewed_at`
- `capacity_reason`

Capacity reasons:

- `saturated: due backlog filled planned capacity`
- `under capacity: due backlog below planned capacity`
- `idle: no due candidates found`
- `exact: requested item selection`
- `idle: no requested open items found`

## Status and Dashboard

Planning and publish steps call `pnpm run status`, which writes structured JSON
under `results/sweep-status/<repo-slug>.json` in generated state. Every sweep
workflow status update must pass the active `--target-repo` so a ClawHub,
ClawSweeper, or OpenClaw lane updates only its own dashboard row. The README
dashboard reads that JSON and shows:

- active Codex target
- planned review items
- planned review shards
- planned review capacity
- due backlog scanned
- oldest unreviewed scanned
- capacity reason

`active Codex target` is the planned number of nonempty Codex shard jobs for the
current run. It is not a live process count from GitHub Actions. For live worker
count, inspect active review shard jobs on the current workflow run.

The live scheduler estimate happens before planning and is intentionally coarse:
it counts active repair-cluster workflow runs as priority work, active exact-item
sweep runs as priority work, active commit-review workflow runs as background
work weighted by the configured commit page size, and other active normal/hot
sweep runs by their live active `Review shard` jobs. Runs that are only
planning, publishing, queued, or waiting for matrix expansion count as one
background worker. GitHub Actions can start or finish jobs after that estimate,
so the scheduler is a throttle, not a distributed lock.

Planning status intentionally does not run `pnpm run reconcile`. Reconciliation
can scan many live GitHub pages and has delayed review shard startup. The
critical path records the planned counts and publishes only
`results/sweep-status/`; publish, apply, and audit still reconcile records before
their state mutations where folder placement matters.

Read-only plan jobs hydrate generated state from a shallow `fetch-depth: 1`
checkout. Review shard jobs skip generated-state hydration because the plan
matrix already contains exact item numbers. Generated-state publish, apply, and
audit jobs keep a full checkout because they may need to rebase and push state
updates.

## Apply

Review is proposal-only. Apply is the only issue/PR scheduler path that mutates
GitHub close state.

Apply wakes every 15 minutes for `openclaw/openclaw` and on offset 15-minute
ticks for ClawHub. It re-fetches live GitHub state, checks labels, author
association, paired issue/PR state, snapshot drift, and repository profile
rules. It closes only unchanged high-confidence proposals and otherwise updates
or syncs the durable ClawSweeper review comment.

Broad normal review publishes records first, then dispatches durable review
comment sync into the separate apply/comment-sync lane. This includes scheduled
runs and workflow-dispatch continuations, so slow GitHub comment writes do not
hold the normal review concurrency group or delay the next 12-shard backfill
wave. Exact issue/PR reviews and repository-dispatch item runs still sync their
selected comments inline before finishing.

Long apply runs commit checkpoints every 5 fresh closes and dispatch a
continuation with a fresh GitHub App token after any checkpoint that closes at
least one item. A saturated scan that closes nothing stops without chaining so
the same records cannot create an unbounded runner loop.

## Continuation and Recovery

When a normal or hot review run fills its planned capacity, the publish job
dispatches another `sweep.yml` run with the same lane inputs. The 5-minute
normal schedule is still the safety net if continuation dispatch fails or GitHub
delays it.

If review shards fail, the recovery job reads failed shard artifacts or failed
job names, extracts their planned item numbers from the original matrix, and
requeues those exact item numbers once with a recovery marker in the additional
prompt.

Review shard jobs are allowed to finish as recovered failures instead of making
the whole sweep appear broken when the recovery job can requeue exact item
numbers. Each shard uploads a small metrics artifact with item numbers, target
repo, start/end timestamps, and review-step outcome. Publish includes artifact
and metric counts in the status detail so setup noise, missing artifacts, and
real review failures can be separated while monitoring.

Each item report also records durable review cost proxies in front matter and a
`Review Telemetry` section: prompt characters, static prompt characters, GitHub
context characters, output schema characters, additional prompt characters,
context collection milliseconds, and Codex review milliseconds. These fields are
intended for scheduler and prompt-budget experiments, so later throughput work
can compare time and token proxies without scraping transient workflow logs.

The generated state checkout uses a blobless partial clone, but it intentionally
keeps full commit history by default. Publish jobs rebase and retry state writes
after races, and shallow state history can make those retries less reliable.

## Audit

Audit is read-only and runs separately from review and apply. It refreshes
`results/audit/<repo-slug>.json` and the README Audit Health table from live
GitHub state. Scheduled audit currently covers:

- `openclaw/openclaw`: `7 */6 * * *`
- `openclaw/clawhub`: `12 */6 * * *`
- `openclaw/clawsweeper`: `17 */6 * * *`

The audit lane first tries a ClawSweeper GitHub App read token for the target
repository. If that token is unavailable, it falls back to the workflow token for
public read-only API access so dashboard rows do not remain `unknown` just
because mutating scheduled work is still gated.

Before calculating audit health, audit also runs the folder reconciler against
live open GitHub state. This is target-read-only and only mutates generated state:
records for items no longer open move from `records/<repo>/items/` to
`records/<repo>/closed/`, reopened archived records move back to `items/`, and
duplicate closed copies are removed. GitHub Actions uses the fast reconciliation
mode that does not fetch each closed item individually for `closed_at`; large
cleanup runs therefore avoid hundreds of per-item GitHub API subprocesses. The
local reconciler still fetches `closed_at` by default for operator runs; pass
`--skip-closed-at` for fast state-only cleanup.

Review publishing applies newly generated artifacts first, then runs the same
fast reconciler once before committing records. It does not run the slower
artifact-apply reconciler and the explicit publish reconciler back to back.

After publishing audit state and reconciled records, audit dispatches the
`openclaw/clawsweeper-state` dashboard renderer; that repository's 15-minute
schedule remains the fallback if dispatch is delayed.

## Monitoring

Useful commands:

```bash
gh api 'repos/openclaw/clawsweeper/actions/runs?per_page=100' \
  --jq '.workflow_runs[] | select(.name == "ClawSweeper") | {id,name,display_title,event,status,conclusion,created_at,head_sha,html_url}'

gh run view <run-id> --repo openclaw/clawsweeper --json jobs \
  --jq '[.jobs[] | select(.name | startswith("Review shard")) | select(.status=="in_progress")] | length'

gh api repos/openclaw/clawsweeper/readme --jq '.content' | base64 --decode
```

Read the remote generated README, not only the local checkout, when checking the
live dashboard. Generated dashboard state is published from GitHub Actions and
can be newer than local files.

## Common Changes

To change how many normal Codex sessions can run, update both
`.github/workflows/sweep.yml` and the planner constants in `src/clawsweeper.ts`.
The workflow can otherwise continue with stale defaults during continuation
runs.

To change review cadence, update the cadence constants and the scheduler bucket
logic in `src/clawsweeper.ts`, then update dashboard labels and this document.

To add a new target repository, add a repository profile, wire schedule target
resolution and concurrency target resolution in `.github/workflows/sweep.yml`,
then confirm the generated state paths remain flat under one repo slug.

To add a new generic owner, add a `generic_fallbacks` entry and include that
owner in `target_inventory.owners`; target fanout will dispatch explicit
per-repository runs without adding owner-specific cron case blocks. Keep
scheduled fanout public-only unless the generated records publish to a private
state surface.
