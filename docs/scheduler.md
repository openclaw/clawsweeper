# Issue and PR Scheduler

- Status: active, volatile architecture and operations reference
- Owner: ClawSweeper maintainers
- Source of truth: `.github/workflows/sweep.yml`, planner/runtime source,
  `config/automation-limits.json`, and focused scheduler tests
- Last verified: `openclaw/clawsweeper@647503ec44b8e777dd172adf974a945367da0d19`
- Update when: cadence, fanout, admission, retry, publication, apply, or
  state-writing behavior changes

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
fast. Scheduled and manual normal backfill keep up to 89 concurrent Codex
review shards when quiet.
Normal `openclaw/openclaw` review has an
active floor of 38 shards for scheduled runs and workflow-dispatch
continuations: due items win first, and if fewer than 38 items are due, the
planner fills the floor with the stalest currently-reviewed eligible items so
review capacity stays warm around the clock.

Scheduled reviews can reuse exact unchanged inputs through structural or
content caches. Changed PR content goes to Codex, including source comments
and formatting. See [Review Cache](review-cache.md) for admission, freshness,
and runtime packaging rules.

## Workflow

The receiver workflow is `.github/workflows/sweep.yml`.

Important source files:

- `src/clawsweeper.ts`: item selection, cadence, planning, review, dashboard,
  and status JSON
- `config/target-repositories.json`: configured non-core target repositories
  and the conservative `openclaw/*` exact-review fallback
- `docs/target-repositories.md`: target onboarding and rollout checklist
- `src/repair/workflow-utils.ts`: GitHub Actions output shaping for plans
- `results/sweep-status/<repo-slug>.json`: Git-backed operational state consumed
  by the dashboard
- `records/<repo-slug>/items/<number>.md`: open item reports in the canonical
  Worker store
- `records/<repo-slug>/closed/<number>.md`: archived item reports in the
  canonical Worker store

The canonical Worker owns `records/**`, while R2 owns `ledger/v1/**` and
`assets/**`. The `state` branch of `openclaw/clawsweeper-state` retains only the
operational `jobs/**`, `results/**`, `notifications/**`, and apply-report paths.
See [State storage](state-storage.md) for the ownership boundary and local
hydration commands.

Broad normal and hot review workflows use run-scoped concurrency groups, so a
new wave can overlap an older wave that has reached its long-tail or publish
phase. Their plan jobs use a separate concurrency group per target repository
with `cancel-in-progress: false`, serializing capacity decisions before each
matrix expands. The default single-pending policy coalesces superseded planner
ticks instead of retaining an unbounded history. Exact-item planners keep a
run-scoped group and do not wait for broad background planning.
Manual exact-item `workflow_dispatch` reviews use an exact-item concurrency
group with the same single-pending policy, so newer revisions replace stale
pending work instead of building a duplicate queue. Durable exact-review leases
use lease-scoped workflow groups and remain owned by the Worker admission lane.
If a successful exact-review run loses its completion callback, reconciliation
uses the saved lease's accepted or deduplicated direct-publication receipt and
requeue plan to preserve one owed source-drift review. The terminal `requeue`
disposition is recorded before completion and stays on the old fenced revision.
A superseded receipt cannot authorize a requeue; a newer command keeps its
current decision and revision through the ordinary finishing path.
The terminal-run backstop retains its `*/15 * * * *` schedule. Event-triggered
lease repair uses the reusable `exact-review-reconcile-run.yml` job with the
`exact-review-reconcile-workflow-run` concurrency group and
`cancel-in-progress: false`: one running job and one pending follow-up, with
new events replacing superseded pending jobs. The lock covers both the cooldown
check and reconciliation. Per-run reliability observations remain separate so
coalescing does not drop telemetry; eligible events still create observer jobs.

Before event repair, `scripts/exact-review-reconcile-guard.mjs` reads the latest
30 runs of `exact-review-reconcile.yml` using
`gh run list --json databaseId,updatedAt`. For runs updated within five minutes,
`gh run view --json jobs` verifies that a lease-reconciliation job actually
succeeded within that window, even if its observer job is still running.
Observer-only runs, skipped repairs, and failed repairs do not extend the
cooldown. A job-level output guard skips repair after a recent
success; unavailable history or the 60-second aggregate history-read deadline
allows repair to proceed. Each lookup is bounded by the remaining deadline,
and a successful result is checked for freshness after the read. Scheduled and
manual sweeps bypass the guard and inspect all claimed runs, so a terminal attempt
whose event was coalesced or skipped is normally reconciled within about
15 minutes worst case, plus Actions scheduling and execution delay. This is a
cadence backstop, not a hard wall-clock guarantee during platform outages.
OpenClaw Bay is unaffected: queue schemas, telemetry observations, and public
observer data contracts do not change.

Queue-completion failures remain visible separately from Codex or content
failures, using the logical generation result and typed deferral rather than
the review process exit alone. The workflow failure gate is unchanged.
Caught Codex failures in an exact-review job also upload a separate 14-day
diagnostic artifact while the runner remains alive. Its `error.txt`,
`stdout.error.txt`, and `stderr.tail.txt` files are sanitized for repository
readers and total at most 24 KiB with the readiness `manifest.json`. The
manifest retains a bounded failure stage, reason code, and the queue's computed
retryability even when unsafe raw detail is omitted. Raw
reports, unstructured stdout, and non-error prompt events are omitted. It is
never a publication input; cancellation, runner loss, or job termination can
still prevent upload. OpenClaw Bay and queue schemas are unchanged.

Recoverable parked reviews use the nominal 5/10/20-minute retry ladder, but
each item persists a schedule-time uniform jitter of 0.75-1.5x for every rung.
After the third automatic recovery, operator-only HMAC-signed routes provide a
bounded parked-review inventory and guarded resolution/fresh-recovery path. The
five-minute dead-letter reconcile workflow inspects at most 100 parked targets,
resolves terminal or repository-gone targets with an audit note, and can queue
at most five fresh reviews with replay-safe recovery keys. A fresh review now
requires a changed source action, head, base, draft state, body/content revision, fallback
source timestamp when no content digest exists, or retry policy epoch; a queue
revision by itself cannot reset the budget. Bump
`EXACT_REVIEW_RETRY_POLICY_EPOCH` when a scanner, policy, or deployment change
should reopen unchanged inputs. Manual workflow dispatches may explicitly opt
into `force_unchanged` for a bounded operator override. Manual runs remain
read-only unless `execute` is enabled; scheduled runs execute. Their sanitized
parked inventory is uploaded beside the publication dead-letter inventory.
Parked records carrying maintainer-command context remain visible with an
exclusion reason but cannot be resolved or fresh-recovered by this background
reconciliation path.
Publication dead letters whose recorded pull-request head no longer matches the
live head are never replayed or resolved from head drift alone. The reconciler
may resolve them as superseded only when the existing HMAC-authenticated
canonical-record read for the same target contains a complete review at that
live head, then rechecks the same open GitHub node and head immediately before
the guarded resolution. Each cycle checks at most ten such targets and resolves at most 20
rows per target; missing or mismatched evidence remains open as
`head_mismatch_unproven`. `tuple_protocol_invalid` and `workflow_cancelled`
rows are excluded from this path. Executed resolutions retain an audit note
with the newer head and canonical endpoint and increment the publication
completed and superseded totals; dry runs perform no mutation.
This drains the existing queue state and does not add a dashboard health input
or an OpenClaw Bay action: Bay remains observer-only.
GitHub throttle deferrals use the same per-item jitter band when the queue turns
the reported cooldown into its next-attempt timestamp, preventing a parked
cohort from becoming eligible in lockstep; coordination and ordinary failure
retries keep their existing timing.
Exact publishers complete as superseded when apply verifies one trusted, complete,
strictly newer durable review tuple for the same revision. The verified result
travels as structured apply evidence; reason text is diagnostic only. Ambiguous
or mixed results cannot terminalize the artifact, and legacy tupleless artifacts
retain the existing fresh-review path.

Legacy protocol-v1 review leases without lifecycle admission rows complete without
writing lifecycle facts. Once a completion commits its queue transition, alarm
scheduling runs even if the subsequent lifecycle update fails, so persisted
retries retain their scheduled wake-up.

Review publication and apply/comment sync use separate non-dropping queues.
Apply treats a typed GitHub installation or abuse-rate-limit response as a
bounded yield, not a failed scan. It checkpoints completed item work, records
the interrupted item as `skipped_runtime_budget`, returns that item to the
cursor, and exits successfully so a later scheduled or continuation cycle can
retry it. This applies to comment-only sync and close-mode apply. Folder
reconciliation also defers before mutation when its open-item scan is
rate-limited; ordinary non-rate-limit failures remain fatal.
The source fallback publication minimum, base, and maximum are 4, 24, and 48,
but production overrides them to 8, 32, and 40. The adaptive controller
classifies GitHub pressure:
a 403/429 or
explicit rate-limit failure records a 15-minute cooldown, while GitHub 5xx
failures record a 5-minute cooldown. Demand and recovery signals scale effective
capacity within the production range. Production batch
preparation is enabled for up to 8 concurrent size-8 batches, including 2
fresh-lane members per batch. Direct publication is also enabled and falls back
to the retry/batch path when the direct result is retryable. Apply/comment sync
remains per-target serialized. See [`docs/limits.md`](limits.md) for effective values and
[`docs/live-dashboard.md`](live-dashboard.md) for the public lane telemetry.
Tuple-aware state reconciliation prevents stale review snapshots from reviving
closed records.

Batch admission is additionally gated by persisted GitHub credential circuits.
Every batch needs the `actions:openclaw/clawsweeper` pool for producer artifact
download, while target App circuits are owner-scoped so one exhausted
installation does not stop healthy owners. A blocked pool prevents workflow
dispatch, state hydration, and artifact download for each matching member until
its reset-plus-deterministic-jitter recovery boundary; the alarm wakes at the
earliest pending member boundary. The current batch collapses after the first
pool failure, and unattempted members return without advancing their retry
budget. Recovery is staggered rather than released as one cohort.
An owner-scoped target App circuit also defers new exact-review admission for
that owner, because review and publication share the installation quota; other
owners remain admissible.
Legacy dispatches normally carry the event repository's validated default
branch. If an older producer omits it, intake creates a durable pre-admission
branch-authority reservation instead of spending the workflow repository's
Actions quota or assuming `main`. Resolution and direct-webhook source-head
verification both consult and update the same owner-scoped target App circuit:
the first quota response preserves its reset deadline, later same-owner
reservations defer without another read or attempt charge, and reset recovery is
bounded by the Durable Object alarm processor.

Exact publication routes only classifier-approved public reads through the
repository Actions token. If that pool is exhausted after the current member's
artifact is already present, the member may use the ambient target App once;
later members still stop because they require the blocked Actions pool. The
workflow also records a typed repository-pool observation if its final comment
router dispatch encounters quota pressure. All typed observations and request
counters are acknowledged with the same fenced batch completion, so a delayed
cleanup is idempotent and cannot duplicate accounting.

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
- issues and PRs may auto-close only when already implemented on `main`

Generic `openclaw/*` and `steipete/*` repositories:

- exact event/manual review: supported through configured generic fallbacks after
  the target dispatcher and GitHub App installation are present
- scheduled review/audit: target fanout dispatches small cursor-based batches
  from `target_inventory.owners`
- private and internal targets: local maintainer review only, using an
  operator-provided checkout
- generic OpenClaw issues may auto-close only when already implemented on the
  default branch; generic OpenClaw PRs may additionally use age-gated mostly
  implemented there
- generic `steipete/*` repositories are review/comment-only for issues and PRs

Manual `workflow_dispatch` can override `target_repo`, `item_number`,
`item_numbers`, `batch_size`, `shard_count`, `hot_intake`, and apply inputs.
For batch input, `batch_size` controls items assigned per worker and
`shard_count` controls requested parallelism within the configured hard cap.
Exact item dispatches use a dedicated concurrency group and exact planner
matrix rather than the broad normal-review queue.

Target fanout dispatches review batches through `repository_dispatch` so each
selected repository can carry its inventory default branch without consuming
manual workflow inputs. Scheduled fanout uses:

- hot intake: `4/20 * * * *`, 20 target repositories per cursor step. This
  20-minute cadence is temporary containment for scheduled self-feedback;
  restore a faster cadence only after the loop is fixed and quota telemetry
  confirms it is safe. [PR #959](https://github.com/openclaw/clawsweeper/pull/959)
  intentionally moved this selector from every 15 minutes to every 5 minutes;
  this containment adjusts that current cadence without attributing the
  self-feedback defect to PR #959.
- normal review: `41/10 * * * *`, 12 target repositories per cursor step
- audit: `37 */6 * * *`, 12 target repositories per cursor step

Audit fanout keeps at most 3 target audits in flight using
`audit.max_parallel_targets` from `config/automation-limits.json`. It dispatches
bounded waves and waits for every acknowledged run in a wave to become terminal
before dispatching the next, including when a target fails or is cancelled.
The dispatch API returns exact run IDs (`return_run_details=true`); a missing
receipt, exhausted lookup retries, or 55-minute wave timeout stops further
dispatch. The existing signed audit cursor stores remaining targets and
outstanding run IDs after each dispatch and completion. The next invocation
resumes that batch and drains the saved children before admitting another wave.
Transient lookup errors retry twice with one- and two-second backoff. Audit
dispatch requires available durable state; an unresolved dispatch receipt stays
marked for operator investigation rather than freeing its slot. Run status is
read once per minute. Coverage inventory tokens are minted again after the waves,
immediately before the trailing coverage summary. The fanout job
allows four hours for the twelve-target batch; ordinary review/hot fanout keeps
its 30-minute timeout. The six-hour cadence, cursor selection, and twelve targets
are unchanged. This bound covers the scheduled fleet fanout, not separate manual
audits or the three dedicated core-repository audit schedules.

[PR #1007](https://github.com/openclaw/clawsweeper/pull/1007) is directly
relevant but was insufficient for the observed `openclaw/libterminal#41`
path. It was intended to recognize structurally proven ClawSweeper-owned
comment or label activity while keeping timestamp-only or incomplete evidence
eligible for conservative structural verification. Its mainline commit
`b83f2983da` predates and is an ancestor of the ClawSweeper head used by
[run 31336140651](https://github.com/openclaw/clawsweeper/actions/runs/31336140651).
That later scheduled run still reported one structural-cache check, zero
structural-cache hits, and one full hydration before publishing the durable
comment again. The evidence therefore shows that #1007 did not suppress this
specific execution path; it does not prove whether the receipt was missing,
incomplete, stale, or bypassed at admission, and it does not make #1007 the
cause of the loop. The temporary cadence reduction bounds demand while that
remaining path is corrected.

There is no ClawSweeper PR #1032: the relevant record is
[issue #1032](https://github.com/openclaw/clawsweeper/issues/1032), which
reported a post-#1007 review storm and was closed by
[PR #1036](https://github.com/openclaw/clawsweeper/pull/1036). PR #1036 changed
the exact-review workflow and review-preparation boundary to forward
`sourceAction` and classify `scheduled_hot_intake` and
`scheduled_normal_backfill` as automatic, making them eligible for receipt and
cache reuse instead of treating queued item numbers as explicit reviews. Its
merge commit `138ee2f96e` predates and is an ancestor of run 31336140651. The
run log contains `--review-source-action scheduled_hot_intake`, so #1036 was
effective at the classification boundary and was not bypassed there. The same
run nevertheless recorded zero structural-cache hits and one full hydration,
making #1036 a partial but insufficient mitigation for this case: it opened the
cache-eligible path, while the available structural receipt still failed to
match. This evidence does not attribute the remaining receipt mismatch to
#1036 itself.

Each mode's cursor lives in the authenticated ExactReviewQueue Durable Object,
not generated Git state. Reads and writes use a monotonic revision. If the
canonical cursor endpoint is unavailable, normal and hot fanout warn and
continue dispatch from a default cursor; persistence failure after dispatch
does not fail those lanes. Audit fanout requires a batch-aware cursor store and
stops on state failures so outstanding children cannot be forgotten.

Normal fanout refreshes the same signed live-open inventory consumed by
`GET /api/review-coverage`, and both normal and hot fanout skip repositories
with no open items. Normal fanout reserves a rotating slot for every selected
repository, keeps the largest untracked backlog in each cycle, and apportions
the remaining candidate volume by backlog share. The rotating slice is
dispatched first, so one large repository can fill otherwise-idle capacity
without permanently consuming smaller repositories' scheduled-feed budget.

Worker hydration also records the exact item identities present in the modern
canonical tuple store. Normal fanout and each target planner use those identities
for the same `untracked_open` boundary as the coverage endpoint. A hydrated
legacy backfill report remains review context, but it does not count as coverage
or yield a planner slot to a canonical re-review until a modern tuple exists.

The six-hour audit fanout also writes a GitHub Actions summary with canonical
open-item reports reviewed in the trailing seven days versus batched live open
issue and PR totals across the complete dynamic inventory.

Exact event review also starts Codex before generated-state hydration. The
single-item review only needs the target repository and live GitHub item state;
generated state is checked out afterward, just before publishing the review
record, safe close result, and command-router ledger.

Default close-mode apply refreshes use that same queue-only intake. The merged
apply report selects at most five distinct source-drift items in report order,
with unverified-checkout holds filling spare slots. The producer resolves the
repository default branch and each selected item's kind with narrow GitHub
reads, then sends `clawsweeper_item` with `source_action: source_drift_requeue`
and `supersedes_in_progress: false`. It does not send `clawsweeper_target_sweep`,
run a broad planner, or hydrate canonical repository records before enqueue.
Read or dispatch failures remain visible step failures; a dispatch notice is
not a durable admission receipt. The existing intake signs the queue request.

`source_drift_requeue` uses the queue's existing low-priority recovery contract:
existing pending or leased work, including maintainer-command context and source
authority, wins; delivery deduplication, pending backpressure, and lease fencing
remain queue-owned. Exact selection requests a fresh review of current source
without a new `force` flag, stale source pin, or producer-supplied lease. Closed
or missing targets still stop at the queue/executor live-state checks. General
manual and broad dispatch behavior, the independent proof cursor, and close
policy are unchanged. OpenClaw Bay needs no change: this producer reuses existing
queue/lifecycle fields and adds no published schema, status field, or control.

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
issue, or maintainer command. Normal review and hot intake are
background work because they keep the backlog fresh but can safely slow down
when priority work is busy. The workflow asks the central worker scheduler for a
lane limit before dispatching background work; see
[`docs/limits.md`](limits.md) for the config, formulas, and examples.

Current defaults:

- exact event review: 1 shard, 1 item
- exact manual hot intake: 1 shard, 1 item
- scheduled hot intake and normal backfill: size candidate selection from live
  queue-advertised capacity, with normal fanout sharing that budget across its
  selected targets. If the capacity probe is unavailable, a direct single-target
  schedule falls back to 50 candidates; normal fanout creates a pool of 50
  candidates per selected target and apportions that pool by backlog. Each
  selected item enters the durable exact-review queue, and every admitted item
  receives its own parallel workflow
- total review admission target: 300 items/hour across the fleet; organic work
  consumes the budget first and scheduled backfill fills the remainder, split
  35% hot intake and 65% normal backfill, with a 30-item burst
- review admission and pressure are computed independently from publication;
  top-level queue health describes reviews while `lanes.publication` retains
  publication backlog, retry, DLQ, and health telemetry
- fleet fanout: 20 hot targets every 20 minutes as temporary self-feedback
  containment, and 12 normal targets every 10 minutes;
  each target cycle can offer up to 50 due items to the shared admission budget
- manual broad hot intake: up to 44 shards when quiet
- manual normal backfill: defaults to 89 shards, batch size 3, and scans up to
  250 GitHub pages unless overridden

The hard planner cap is 128 shards. The workflow clamps invalid or larger
`shard_count` inputs to 128.

Broad background review clamps manual `shard_count` input to the current
lane allowance from `worker-limit`. Pending or planning background sweeps reserve
their quiet lane size until their matrix shards exist, so overlapping manual or
operator dispatches cannot temporarily exceed the shared worker budget while
GitHub is still expanding jobs. Scheduled feeds use one planner shard because
the Durable Object, not the matrix, owns review concurrency.

Planning is also the runtime build point for manual matrix review. The plan job installs
with pinned Node 24 and `pnpm@11.10.0`, builds `dist/` once, and uploads that
runtime artifact. Review shards download the built `dist/` and run
`node dist/clawsweeper.js review` directly instead of running a per-shard pnpm
install and build. Scheduled queue feeds skip this artifact because each exact
review workflow builds from its immutable queue decision.

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

Normal backfill runs every 5 minutes for `openclaw/openclaw`. Its planner
serializes per target repository, selects globally before sharding, and offers
never-reviewed candidates before the oldest due tracked candidates to the
durable queue. Queue admission is fleet-wide,
so overlapping core and fanout cycles fill only the residual of the configured
300/hour model-spend target after organic review demand.

The manual quiet-system ceiling is not a promise that every operator run dispatches
that many shards. The `mode` step checks active repair workers, exact-item sweep
runs and live normal/hot review shard jobs, then asks
`worker-limit normal_review` or `worker-limit hot_intake` for the current
allowance. Planning, queued, and not-yet-expanded background runs reserve their
whole quiet-system lane. A run with completed shard jobs and no active shard
jobs is publishing and counts as zero Codex workers, allowing the next planner
to refill the lane. If
repair/automerge is busy, background sweep dispatches fewer shards and leaves
capacity for the specific work that is closest to a merge or maintainer request.
Background lanes also subtract an 8-worker expansion reserve so independently
planned exact-item runs have room to start without pushing the
live Codex count past the global budget.

The manual active floor is not a separate lane and does not change close/apply safety.
It only changes normal planning when due backlog is below the desired floor:
after selecting all due candidates, the planner fills up to 38 nonempty shards
with eligible items whose latest complete review is at least 6 hours old.
Capacity status reports this as `floor: due backlog below active floor`. If the
central worker scheduler returns fewer than 38 allowed shards, the smaller
worker allowance wins.

Scheduled planning does not use the active-floor backfill. It selects only due
items, records each candidate's previous-review age in `plan.json`, and writes a
run-summary funnel for selected, attempted, enqueued, deduped, shed, and deferred
items. The queue exposes the configured rate, burst, and currently available
token balance under `scheduled_feed` in `GET /api/exact-review-queue`. It also
exposes backpressure and scheduled-rate shed counts separately so an operator
can distinguish a full review queue from intentional 300/hour pacing. The
30-item burst bounds a cold-start cohort to roughly 900 GitHub requests at the
observed planning average of 30 requests per completed review.
The producer probes that field before its first enqueue and fails closed while
an older Worker is still deployed, preventing a workflow-first rollout from
bypassing the rate limiter.

Normal fanout ordinarily divides one live queue-advertised candidate-capacity
budget across the selected repositories; it does not grant 50 candidates to
each target. If that capacity probe is unavailable, the bounded fallback for a
10-minute cycle is `50 items/target * 12 targets = 600 items/cycle`. Six cycles
per hour make that fallback's theoretical pre-filter ceiling 3,600 offers/hour
before due filtering, planner capacity clamping, dedupe, and Worker admission.
A direct five-minute schedule for one target also uses live advertised capacity;
its fallback can offer `50 items/cycle * 12 cycles/hour = 600 items/hour` before
the same bounds. These paths therefore have enough candidates to keep the
shared token bucket fed despite dedupe or uneven fleet distribution. The queue
admits at most 300 scheduled reviews/hour, which needs
about `300 * 4.1 / 60 = 21` concurrent review workers at a 4.1-minute mean
service time and budgets roughly 9,000 GitHub requests/hour. That leaves about
6,000 requests in the shared 15,000-request installation allowance for exact
ingress, routing, apply proof, publication, and support lanes. The target rate
and burst are GitHub spend dials. The pending soft limit is a separate queue
backpressure bound and should change only when queue-memory or latency evidence
requires it, not automatically with the request budget.

On saturated queues, normal planning reads the complete bounded open-item scan
before selecting candidates. For the current largest repository this is about
60 REST pages per five-minute normal tick, or roughly 720 installation-token
requests per hour; that bounded cost is necessary for oldest-review fairness.

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
The live open-item scan is compared with the canonical record index first.
Items with no canonical record consume capacity before any re-review. Within
that never-reviewed cohort, six-day coverage ordering and the existing weighted
bucket mix still apply. Once first-review candidates are exhausted, tracked
items enter the six-day coverage lane in oldest-`reviewed_at` order across all
buckets before hot-item churn. Normal planning completes its bounded scan before
applying that ordering, so a saturated item-number prefix cannot hide either
untracked items or older review timestamps. The extra day is operational
headroom before the seven-day freshness deadline.

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
- `dueBacklog`: due candidates found during the complete bounded scan
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
sweep runs as priority work, and other active normal/hot
sweep runs by their live active `Review shard` jobs. Runs that are planning,
queued, or waiting for matrix expansion reserve their quiet lane. Runs whose
shards have completed and are only publishing count as zero Codex workers.
GitHub Actions can start or finish jobs after that estimate,
so the scheduler is a throttle, not a distributed lock.

Planning status intentionally does not run `pnpm run reconcile`. Reconciliation
can scan many live GitHub pages and has delayed review shard startup. The
critical path records the planned counts and publishes only
`results/sweep-status/`; publish, apply, and audit still reconcile canonical
records where folder placement matters.

Read-only plan jobs hydrate canonical records plus the Git-backed operational
paths they consume. Review shard jobs skip state hydration because the plan
matrix already contains exact item numbers. Publish, apply, and audit jobs
hydrate only the operational Git paths they still read or write; record
publication goes directly to the Worker.

## Apply

Review is proposal-only. Apply is the only issue/PR scheduler path that mutates
GitHub close state.

Apply wakes every 15 minutes for `openclaw/openclaw` and on offset 15-minute
ticks for ClawHub. It re-fetches live GitHub state, checks labels, author
association, paired issue/PR state, snapshot drift, and repository profile
rules. It closes only unchanged high-confidence proposals and otherwise updates
or syncs the durable ClawSweeper review comment.

Apply reconciles hydrated records before both candidate preselection and
execution. Each pass immediately publishes only the item, closed, plan, and
decision-packet paths for record numbers it changed. This keeps folder moves
and closed-item sidecar cleanup durable even when policy filtering, an empty
comment-sync batch, or an empty close queue makes the rest of the run a no-op.
If another publisher updates the same tuple first, its newer tuple wins and
reconciliation defers that item instead of rebuilding stale report or sidecar
content.

Batch review publishers hydrate only the item tuples present in their artifacts,
publish those records, and synchronize the selected durable review comments in
the same job. Exact issue/PR reviews likewise synchronize their selected comments
before completing. Neither path dispatches a second broad comment scan.

Automatic apply may close up to 40 items per run. Long apply runs commit
checkpoints every 40 fresh closes and dispatch a
continuation with a fresh GitHub App token after any checkpoint that closes at
least one item. A saturated scan that closes nothing stops without chaining so
the same records cannot create an unbounded runner loop.

Untargeted cursor-based close apply starts with a 600-record scan window. If
the previous cursor window was a full close-mode scan, closed nothing, skipped
at least 80% of processed records, and did not hit a live-fetch, runtime-budget,
or missing-cursor failure, the next automatic window expands to inspect more
records, capped at 1800. Each automatic checkpoint may spend up to 20 minutes
in deterministic apply scanning, while the existing 55-minute App-token budget,
70-minute apply step, and six-hour coordinator job ceiling remain unchanged.
This changes only the deterministic scan window:
`apply_limit`, checkpoint size, close gates, live-state checks, and maintainer
policy gates stay unchanged. The workflow logs and sweep status detail include
the selected scan window and reason.

Automatic windows reserve up to two candidates for PR close-coverage proof,
capped by the effective close budget. Confirmed proof-gated close proposals stay
ahead of speculative promotion proofs; spare proof capacity rotates promotions
on the same independent proof cursor. Reserved proofs run before deterministic
closes could exhaust the checkpoint's mutation limit. An executor trace advances
each cursor only through records actually examined, so a partial window preserves
unexamined candidates and each pool resumes from its exact last-examined
position. Coverage proof, live-state refresh, freshness checks, and close gates
remain unchanged. Explicit targeted apply runs keep their requested item set and
ordering policy.

Apply keeps selected report bodies in memory and loads independently reviewed
paired records only when a close guard requests them. Exact-event publication
does not expand its selected set. Broad apply still sorts the complete open
candidate set; it no longer loads a second copy for paired lookups. Finalization
reloads only requested, result, and unfinished/in-flight item records from the
open and closed directories, rather than retaining the archive. This includes
partial failures and runtime-budget yields and does not change cursor ordering,
close eligibility, canonical baselines, or ledger identities. OpenClaw Bay needs
no change: the public status, record, and ledger contracts are unchanged.

Before a close-mode apply run starts, the workflow summarizes the selected close
candidate mix by quality bucket in the status detail. Buckets such as
implemented-on-main, duplicate/superseded, needs PR close proof,
aging/low-signal (including stalled-unproven and abandoned PRs),
policy-sensitive, and retry-after-guard-skip are
operator-facing telemetry only; the bucket classification does not change close
limits, live-state checks, or policy gates. Stalled-unproven and abandoned PR
proposals are eligible for apply selection, where the executor re-checks their
PR-only age, activity, proof, status, and human-engagement gates before closing.

After a default close-mode cursor run for `openclaw/openclaw`, the apply job
requeues up to five exact reviews for records whose close was blocked by
source drift (`skipped_changed_since_review`) or by a stored review without
verified local checkout access. Both blocks have the same cure: a fresh exact
review re-verifies the close proposal at the current snapshot and writes a
close-capable record, so the next apply pass can execute instead of skipping
the same stale records every sweep. The per-run cap bounds review spend, and
the exact-item queue's supersession semantics absorb repeat dispatches.

Apply and comment-sync Actions run titles include the target repository. Before
dispatching a default cursor-based apply continuation, the workflow checks
recent active or queued same-target default cursor runs and treats one of those
runs as the continuation instead of adding another pending run. Custom-input
and explicit-item runs have a different title and cannot suppress the default
cursor lane; their own continuations still dispatch with the exact inputs. The
log identifies the default cursor run that covered the continuation.

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

The remaining operational state checkout uses a blobless shallow clone. Git
publication is serialized by the Durable Object state-writer coordinator and
uses one ordinary fetch, commit, and push.

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
live open GitHub state. This is target-read-only and mutates only canonical
Worker records: reports for items no longer open move from `items/` to `closed/`,
reopened archived reports move back to `items/`, and duplicate closed copies are
removed. GitHub Actions uses the fast reconciliation mode that does not fetch
each closed item individually for `closed_at`; large cleanup runs therefore avoid
hundreds of per-item GitHub API subprocesses. The local reconciler still fetches
`closed_at` by default for operator runs; pass `--skip-closed-at` for fast
canonical cleanup.

Review publishing applies newly generated artifacts first, then runs the same
fast reconciler once before committing records. It does not run the slower
artifact-apply reconciler and the explicit publish reconciler back to back.

After publishing Git-backed audit results and reconciling canonical records,
audit dispatches the `openclaw/clawsweeper-state` dashboard renderer; that
repository's 15-minute schedule remains the fallback if dispatch is delayed.

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

To change review spend, set
`EXACT_REVIEW_TARGET_RATE_PER_HOUR`; the Worker applies the fleet-wide rate
while scheduled planners size their candidate batch to free review capacity.
Target fanout divides that capacity by untracked backlog after reserving its
round-robin fairness slice. To change manual normal Codex sessions, update the
worker limits and workflow defaults together.

To change review cadence, update the cadence constants and the scheduler bucket
logic in `src/clawsweeper.ts`, then update dashboard labels and this document.

To add a new target repository, add a repository profile, wire schedule target
resolution and concurrency target resolution in `.github/workflows/sweep.yml`,
then confirm the generated state paths remain flat under one repo slug.

Hosted owner fallback is limited to `openclaw/*` and `steipete/*`. To schedule
another owner, add explicit repository profiles and include that owner in
`target_inventory.owners`, then wire that owner's inventory token or explicit
public-inventory fallback into the fanout workflow. Configuration alone does
not activate a new owner. Fanout ignores every repository that is not admitted
by the shared configured-profile-or-owner-fallback policy. Keep scheduled
fanout public-only unless the generated records publish to a private state
surface.
