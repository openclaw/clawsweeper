# Automation Limits

- Status: active generated/validated configuration reference
- Owner: ClawSweeper maintainers
- Source of truth: `config/automation-limits.json`, Worker overrides, and
  `scripts/check-limits.ts`
- Last verified: `openclaw/clawsweeper@647503ec44b8e777dd172adf974a945367da0d19`
- Update when: worker budgets, lane ratios, workflow literals, or production
  capacity overrides change; run `pnpm run check:limits`

Read when changing ClawSweeper throughput, Codex fan-out,
or repair dispatch capacity.

`config/automation-limits.json` is the source of truth for the global worker
budget. It deliberately has one main global knob, `workers.max`, because that is
the number we normally tune when Codex or GitHub rate limits get tight. Most
lane-specific limits are derived from that budget; imported cluster repair has
a separate explicit knob so it can stay tightly bounded unless a maintainer
intentionally opens it wider. Safety thresholds such as
close age floors, apply delays, retry counts, and comment caps stay near the
code that owns those decisions.

Review-intake rate limits and the default-off per-author PR-budget and
obsolescence policies follow that safety-threshold rule. Their tunables and
safety floors live beside the owning policy rather than in the global worker
budget:

| Environment variable                              | Default | Meaning                                              |
| ------------------------------------------------- | ------: | ---------------------------------------------------- |
| `CLAWSWEEPER_AUTHOR_PR_BUDGET_CLOSE_ENABLED`      | `false` | Enables live per-author budget closes.               |
| `CLAWSWEEPER_AUTHOR_PR_BUDGET`                    |      15 | Allowed open PRs per external author and repository. |
| `CLAWSWEEPER_AUTHOR_PR_BUDGET_MAX_CLOSES_PER_RUN` |       5 | Gradual trim cap per author in one apply run.        |
| `CLAWSWEEPER_BULK_FILER_THRESHOLD`                |      10 | Recent authored-issue count that marks bulk filing.  |
| `CLAWSWEEPER_BULK_FILER_WINDOW_DAYS`              |       7 | Lookback window for authored issue filing rate.      |
| `CLAWSWEEPER_STALE_VERSION_BUG_CLOSE_ENABLED`     | `false` | Enables stale-version bug closes after 120 days.     |
| `CLAWSWEEPER_OBSOLETE_FIX_PR_CLOSE_ENABLED`       | `false` | Enables obsolete small-fix PR closes after 90 days.  |

See [`author-pr-budget-close-policy.md`](author-pr-budget-close-policy.md) for
the rating, proof, inactivity, engagement, and fail-closed gates.
See [`obsolescence-close-policies.md`](obsolescence-close-policies.md) for the
120/90-day issue and 90/30-day PR age/inactivity contracts.

GitHub repository variables still override selected live limits. When a variable
is unset, workflows read the checked-in budget after checkout. The one exception
is the `workflow_dispatch.inputs.shard_count.default` value in
`.github/workflows/sweep.yml`: GitHub renders that UI before checkout, so it
must remain a YAML literal. `pnpm run check:limits` verifies that literal and the
docs stay in sync with the derived budget.

The mental model:

- `workers.max` is the global Codex capacity budget.
- GitHub Actions workflows that only route comments, publish exact-review results,
  or reconcile leases do not execute Codex and do not consume that budget.
- Priority lanes are repair, issue implementation, and exact-item review.
- Background lanes are normal review and hot intake.
- Assist has a small fixed cap because it is lightweight maintainer Q&A, not a
  derived review or repair lane.
- Background lanes shrink when priority work is already active.
- Runtime overrides are escape hatches, not the normal tuning surface.

## Worker Budget

Audit hydration is bounded independently of review capacity:

| Name | Current | Meaning |
| ---- | ------: | ------- |
| `audit.max_parallel_targets` | 3 | Target audits dispatched per wave; wait for every run to complete before the next wave. |

The fanout reads this limit through `AUTOMATION_LIMITS` in `src/limits.ts`.
The signed audit cursor checkpoints remaining targets and outstanding children;
resumed batches drain those children before admitting a new wave.
It does not alter worker budgets, exact-review admission, or target selection.

| Name                                       | Current | Meaning                                                                                         |
| ------------------------------------------ | ------: | ----------------------------------------------------------------------------------------------- |
| `workers.max`                              |     128 | Maximum global Codex worker budget used to derive lane limits.                                  |
| `workers.reserve_for_interactive`          |      16 | Worker slots background lanes leave open for exact/manual/urgent work.                          |
| `workers.expansion_reserve`                |       8 | Extra slots background lanes leave open for independently planned matrix expansion.             |
| `workers.minimum_background`               |      16 | Target floor for background progress when enough global capacity is available.                  |
| `lanes.exact_review.max_concurrent`        |     128 | Maximum concurrent exact-item review workflow runs admitted to Codex.                           |
| `lanes.exact_review.target_max_concurrent` |     120 | Maximum concurrent exact-item review workflow runs one target repository may consume.           |
| `lanes.exact_review.actions_budget`        |     194 | At 128 reviews and 40 publishers, preserves the 16-slot hard reserve plus 10 slots of headroom. |
| `lanes.assist.max`                         |      10 | Maximum concurrent lightweight assist jobs.                                                     |
| `lanes.repair.cluster_max_live_runs`       |       2 | Default live repair workflow cap for imported gitcrawl cluster dispatches.                      |

## Derived Limits

Review and existing repair limits are intentionally percentages of
`workers.max`; imported cluster repair has its own lane knob. With
`workers.max = 128`, normal review can use 89 workers, hot intake can use 44, existing repair lanes dispatch 51
live workers by default, and imported cluster repair dispatches two live workers
by default.

| Name                                                | Current | Meaning                                                                               |
| --------------------------------------------------- | ------: | ------------------------------------------------------------------------------------- |
| `exact_review.concurrent_max`                       |     128 | Exact-item review admission cap, clamped to `workers.max`.                            |
| `exact_review.target_concurrent_max`                |     120 | Exact-item per-target admission cap, clamped to global exact-review capacity.         |
| `assist.default`                                    |      10 | Maintainer assist job cap.                                                            |
| `review_shards.normal_default`                      |      89 | Quiet-system normal review shard ceiling.                                             |
| `review_shards.normal_active_floor`                 |      38 | Minimum active normal review shards to keep queued for `openclaw/openclaw`.           |
| `review_shards.hot_intake_default`                  |      44 | Quiet-system broad hot-intake review shard ceiling.                                   |
| `review_shards.exact_item_default`                  |       1 | Exact-item hot-intake shard count.                                                    |
| `review_shards.hard_cap`                            |     128 | Maximum accepted review shard count.                                                  |
| `repair_live_runs.default`                          |      51 | Default live repair workflow run cap for manual dispatch/requeue/self-heal.           |
| `repair_live_runs.hard_cap`                         |     128 | Absolute live repair run cap accepted by explicit CLI/env overrides with this config. |
| `repair_live_runs.automerge_default`                |      51 | Live repair run cap for automerge comment-router dispatches.                          |
| `repair_live_runs.issue_implementation_default`     |      51 | Live repair run cap for issue-to-PR implementation intake.                            |
| `repair_live_runs.cluster_default`                  |       2 | Live repair run cap for imported gitcrawl cluster dispatches.                         |
| `issue_implementation.dispatches_per_sweep_default` |       5 | Maximum implementation intake jobs queued from one review publish run.                |

Formula summary:

- normal review: 70% of `workers.max`
- normal active floor: 30% of `workers.max`
- hot intake: 35% of `workers.max`
- repair, automerge repair, and issue implementation: 40% of `workers.max`
- imported cluster repair: `lanes.repair.cluster_max_live_runs`, clamped to
  `workers.max`
- issue implementation dispatches per sweep: 4% of `workers.max`
- review hard caps: `workers.max`
- repair hard cap: `workers.max`

## Dynamic Scheduling

Manual normal review and manual hot intake are background lanes.
Before they dispatch, the workflow asks
`pnpm run workflow -- worker-limit <lane>` for the current allowance. Automated
normal and hot cycles enqueue exact-review work instead, so the Durable Object's
rate, backlog, and claim limits own their concurrency.

The scheduler does this for background lanes:

1. start with `workers.max`
2. subtract active priority work, currently repair workers plus exact-item sweep
   runs
3. subtract active background work already known to the workflow, meaning
   other active normal/hot sweep runs
4. reserve `workers.reserve_for_interactive`
5. reserve `workers.expansion_reserve` for independently planned matrix waves
6. cap the result at the lane's derived quiet-system ceiling
7. return at least 1 so an enabled lane can still make slow progress

The normal result is then reduced when the exact-review queue is under pressure.
Each planner reads the public, unauthenticated `GET /api/exact-review-queue`
endpoint once and uses its review-lane pending count and oldest-pending age. The
top-level pending, ready, admissible, handoff, and pressure fields are aliases
for that review lane; publication health and backlog remain under
`lanes.publication` and never throttle review producers. A failed, timed-out, or
malformed response uses the conservative unavailable-pressure budget until the
next healthy probe.

| Tier | Trigger, either condition                                     | Background budget                            |
| ---- | ------------------------------------------------------------- | -------------------------------------------- |
| none | Below both soft thresholds                                    | Normal dynamic budget                        |
| soft | At least 150 pending or oldest pending is at least 30 minutes | `ceil(normal dynamic budget * 0.5)`          |
| hard | At least 400 pending or oldest pending is at least 2 hours    | `max(1, floor(normal dynamic budget * 0.1))` |

The thresholds can be overridden with repository variables or process
environment variables. Values are non-negative counts or millisecond durations;
unset, empty, or invalid values use the defaults.

| Environment variable                      | Default |
| ----------------------------------------- | ------: |
| `CLAWSWEEPER_QUEUE_PRESSURE_SOFT_PENDING` |     150 |
| `CLAWSWEEPER_QUEUE_PRESSURE_HARD_PENDING` |     400 |
| `CLAWSWEEPER_QUEUE_PRESSURE_SOFT_AGE_MS`  | 1800000 |
| `CLAWSWEEPER_QUEUE_PRESSURE_HARD_AGE_MS`  | 7200000 |

Only manual normal review and manual hot intake use this pressure
multiplier. Scheduled review uses the queue's 600-item soft limit and 300/hour
admission target. Repair, assist, issue implementation, cluster repair, and
exact-item review keep their existing priority budgets.

Background planner jobs serialize per target repository. A sweep that is still
planning, queued, or expanding its matrix reserves its quiet lane size. Once
its shard jobs exist and all finish, its publish phase counts as zero workers,
allowing the next planner to refill the available capacity. Broad manual review
`shard_count` inputs are also capped by the current lane allowance; exact-item
runs still use the exact-item lane.

Priority lanes do not subtract the interactive reserve. They cap themselves at
their derived lane ceiling and at the remaining global budget after other active
priority work.

Exact-item webhooks are admitted by the dashboard Worker's durable
`ExactReviewQueue`, not by a live Actions semaphore. Its production queue logic,
including storage migrations, leasing, reclamation, debounce, and shedding, lives
in `dashboard/exact-review-queue.ts`; `dashboard/worker.ts` is the fetch and
dashboard router and only imports that service boundary. The queue coalesces
deliveries by repository and item number, so a new webhook updates the latest
desired review rather than consuming another runner. Only
`EXACT_REVIEW_QUEUE_MAX_CONCURRENT` leased items may dispatch an exact-review
workflow at once; the default is 128. `EXACT_REVIEW_TARGET_MAX_CONCURRENT` bounds
how many of those slots one target repository may consume; production sets it
to 120 so other target repositories retain eight global slots during an OpenClaw
backlog drain. Exact capacity is consumed only while queue work is pending. As
those priority workers start, normal and hot-intake planners
count them and reduce their next background wave.

`EXACT_REVIEW_ACTIONS_BUDGET` is deliberately separate from the 128-slot Codex
worker budget. Its production value is 194: 128 exact reviews, up to 40
publisher slots, the enforced 16-slot control-plane reserve, and 10 slots of
headroom under the current publication maximum. Full review admission therefore
cannot reduce verdict publication to zero, while repair and broad review
derivations remain anchored to `workers.max = 128`.

Fresh webhook work waits for `EXACT_REVIEW_DISPATCH_DEBOUNCE_MS` (90 seconds by
default) so rapid edits and pushes coalesce before dispatch. Repeated pending
revisions extend that delay up to `EXACT_REVIEW_DISPATCH_DEBOUNCE_MAX_MS` (three
minutes by default) from the item's first enqueue. A superseding source event
immediately revokes the old queue lease and starts a fresh debounce window for
the latest revision. The old workflow's tuple heartbeat then returns `409`; its
review step terminates the local review process instead of using GitHub's
run-id-only cancellation API, which cannot safely distinguish a later rerun
attempt. The replacement is durably scheduled before the old worker observes
the revocation, and
`review_superseded_total` records the terminalized review generation. Recovery
events never supersede an existing item; only a fresh source revision can revoke
an active review. Duplicate workflow deliveries remain non-cancelling and rely
on the lease claim tuple, so they cannot terminate the sole valid owner. An older
unclaimed workflow cannot pass the replacement lease tuple and exits before
review compute. Explicit command work and publication work bypass the delay.
When pending depth reaches
`EXACT_REVIEW_PENDING_SOFT_LIMIT` (600 by default), new recovery and scheduled
feed work is shed; this threshold counts review work only, so publication
backlog cannot consume review admission capacity. Existing items, webhook
events, commands, and publications remain admitted. The queue reports shed
counts under `lanes.review.shed_reasons_since_reset` and the rolling flow by
`backpressure` versus `scheduled_rate`; pre-migration totals remain
`unattributed`. All newly queued review work debits a durable 300-review/hour
budget with a 30-item burst. Organic work is always admitted and consumes the
budget first; scheduled work fills the remainder and is split 35% hot intake and
65% normal backfill so hot churn cannot starve oldest-first coverage. Re-offering an item
that is already pending, dispatching, or leased is a semantic dedupe: it does not
advance the queue revision, revoke a lease, or count as new work.

Exact-review result publication has a separate adaptive Actions lane. Source
fallback minimum, base, and maximum are 4, 24, and 48; production overrides
them to 8, 32, and 40. The controller records GitHub
pressure, cooldown, recovery, and demand telemetry, and can scale within that
production range. Admission enforces a 16-slot control-plane reserve inside
`EXACT_REVIEW_ACTIONS_BUDGET`; with 128 active exact reviews and the current
production maximum of 40 publisher slots, another 10 slots remain as configuration
headroom rather than protected reserve.
Its checkout, artifact handling, comment sync, and result routing are
deterministic control-plane work: they consume GitHub runners, but not Codex
slots. The comment router and the singleton lease reconciler follow the same
accounting rule. Dashboard Codex capacity therefore counts only jobs whose steps execute
Codex and does not deduct these control-plane workflows from `workers.max`.

Legacy state-repository publication once limited exact-review preparation to
four concurrent size-8 batches. Canonical Worker publication removes that
shared Git writer constraint, so production now admits 8 preparation
batches (up to 64 publication members) while retaining the Durable Object's
transactional SQLite ownership boundaries.

The durable control plane owns reset-aware GitHub credential circuits for both
review authority reads and publication batching. The
repository Actions pool is identified only as `actions:openclaw/clawsweeper`;
target App pools are identified by the non-secret target owner. A primary or
secondary rate-limit observation persists its reset deadline in the queue
dispatcher and suppresses new batch dispatch for only the affected pool. Each
matching member resumes at its reset-plus-deterministic-jitter boundary, and
the next alarm uses the earliest pending member recovery boundary. A later
observation may extend but cannot shorten an open circuit. When `gh` omits
response headers, the publisher
performs at most one same-credential `/rate_limit` lookup; the one-minute
fallback is used only when no authoritative reset is available.

Legacy exact-review payloads that do not carry `target_branch` are durably held
before admission while the target App resolves the repository default branch;
they never silently default to `main`. The same owner-scoped target App circuit
protects that lookup and direct-webhook pull-request head verification. The
first reset-aware 403/429 opens the circuit; later reservations for that owner
defer to the shared deadline without another GitHub request or another
reservation attempt, while other owners continue. A carried valid branch takes
the normal enqueue path with no branch lookup.
The status payload exposes these pre-admission records under
`lanes.review.authority_pending`; owner-scoped circuit `affected_pending` counts
include them, so quota pressure before normal queue admission remains visible.

The first quota failure in a preparation batch stops later members before
artifact download. The observing member records a normal retryable failure;
members that never made a GitHub request are requeued after the shared reset
with deterministic 1-30 second per-member recovery jitter and do not consume
their individual publication retry or dead-letter budgets. A classifier-approved
public `openclaw/openclaw` read may make one bounded fallback from the exhausted
Actions token to the already-authorized target App token. That success does not
close the Actions circuit, and mutations, private reads, and unsupported routes
never use the repository token.

`lanes.publication.github_request_metrics` measures the successful and failed
request budget by redacted credential scope, endpoint category, public-read
versus App-operation class, first versus repeated revision, and outcome. It
contains counts only: no repository item number, URL, content, token, token
hash, authorization header, or filesystem path is retained. Use these counters
to justify later cache or metadata-read consolidation; live freshness and
pre-mutation guards remain mandatory.

Each dispatched workflow claims its opaque lease before checkout. Protocol v2
binds claim and completion to the item key, lease revision, run attempt, claim
generation, source head (for pull requests), and an immutable decision snapshot.
For pull requests, the review-start reservation rejects a claimed source head
that no longer matches the live head, then heartbeats that full queue tuple
before deleting any different-revision placeholder. During the rolling-upgrade
window, dispatches nest the strict tuple under `queue_claim`, also carry the immutable v1 snapshot, and the Worker accepts
lease-id-only finalization only for claims recorded as protocol v1. Duplicate
dispatches and stale workflows cannot claim the same lease, and a completion
immediately schedules a known newer revision. Failed and cancelled executors
requeue their item with bounded retry backoff. Successful finalizer reports stay
leased until a signed terminal-run reconciliation backstop confirms that exact
GitHub attempt completed successfully; this backstop can also recover terminal
failed or cancelled runs before lease expiry. Event-triggered lease repair shares
one running and one pending job in `exact-review-reconcile-workflow-run` with
`cancel-in-progress: false`. A five-minute successful-reconciliation guard
suppresses redundant scans; skipped and observer-only runs do not reset it.
Per-run reliability observations retain their own jobs so no telemetry is lost.
The independent `*/15` sweep reads `/internal/exact-review/claimed-runs`, checks
exact GitHub attempts in batches of eight, and posts terminal tuples to
`/internal/exact-review/reconcile`. It bypasses the event cooldown, providing an
approximately 15-minute backstop for coalesced terminal events, subject to Actions
scheduling and API availability. See [Scheduler](scheduler.md) for the bounded
Actions history reads that implement the cooldown. Unclaimed
dispatches expire after six minutes and receive a new opaque lease; delayed
workflows holding the expired lease cannot claim it. The six-minute timer covers
only the GitHub dispatch-to-claim handoff. Once the first workflow step claims
the item, the 130-minute execution lease and one-minute heartbeats take over, so
the handoff recycler cannot race a normal four-minute review completion.
Run-attempt binding and a per-claim generation check keep delayed terminal
decisions from releasing a later rerun; queued and in-progress runs are never
released. If a workflow never claims or completes, the Durable Object reclaims
the expired lease. Claimed review workers heartbeat every minute; after the first
heartbeat, `EXACT_REVIEW_HEARTBEAT_GRACE_MS` bounds liveness to 20 minutes by default while
never extending the original 130-minute execution lease. Leases created before heartbeat
support was deployed retain their original execution expiry. This keeps capacity waiting and
retry state out of GitHub Actions runners.

Publication completion distinguishes durable publishes from results superseded
by a newer or closed remote tuple. Superseded publications terminate without a
GitHub mutation and do not count as successful publishes. GitHub/transient
failures retry for at most 12 attempts or 24 hours; deterministic permanent
failures receive two confirmation retries before entering the bounded
dead-letter store. An artifact unavailable for three attempts atomically queues
one fresh review. Public queue status reports publish, supersede, retry, refresh,
and dead-letter totals separately; signed internal endpoints list, replay,
resolve, and exact-revision supersede records without exposing decisions publicly.

Examples with the current config:

- Quiet system: manual normal review can request 89 shards, with 104 background
  slots available after reserving 16 for interactive work and 8 for matrix
  expansion. When the queue capacity probe is unavailable, a single-target
  scheduled plan falls back to offering up to 50 candidates to the durable
  300-review/hour admission target with a 30-item burst instead of starting
  matrix shards.
- 4 active repair workers and 96 active background workers: normal review gets
  4 because `128 - 16 interactive reserve - 8 expansion reserve - 4 priority
  - 96 background = 4`.

Use these commands to inspect the effective values from a checkout:

```bash
pnpm run --silent workflow -- worker-config
pnpm run --silent workflow -- limit review_shards.normal_default
pnpm run --silent workflow -- worker-limit normal_review
```

Change `workers.max` first when tuning review-side rate-limit pressure. For
example, setting `workers.max` to `40` automatically makes normal review `28`
and hot intake `14`. Existing repair lanes keep their
40% derived caps, while imported cluster repair remains separately bounded until
`lanes.repair.cluster_max_live_runs` is raised.

## Canonical record export

`/internal/state/records/export` defaults to 200 records and accepts at most
200 per request. Its reconstruction cap is also 200, and the hydration client
requests 200 by default. A replay of 111,000 small records therefore needs
555 requests instead of 2,220 with the former 50-record cap.

The source-content budget remains 2 MiB and the serialized-entry budget remains
4 MiB. Byte preflight selects identities before a single batched source read;
chunked records retain their existing reassembly. Large records can end a page
before the count limit, and `nextCursor` advances only through returned records.
The existing single-record progress exception is retained: the first record is
returned even if it exceeds a page byte budget, preventing an unexportable record
from pinning the cursor. The serialized budget measures entries, not the outer
JSON envelope.

These limits are owned by `dashboard/exact-review-queue.ts`, implemented in
`dashboard/exact-review-direct-publication.ts`, and consumed by
`scripts/worker-records.ts`. Regression coverage lives in
`test/record-export-bounds.test.ts` and `test/worker-records-request.test.ts`.

## Runtime Overrides

- `EXACT_REVIEW_HOSTED_TARGET_ADMISSION_FRESH_MS`: intake's no-probe public-admission cache window (default 60,000 ms).
- `EXACT_REVIEW_HOSTED_TARGET_ADMISSION_MAX_STALE_MS`: intake fallback after retryable probes (default 1,800,000 ms; zero disables caching; terminal probes revoke).
- `EXACT_REVIEW_STALE_PUBLICATION_PRUNE_LIMIT`: stale-revision cleanup per alarm (default 100; zero disables).
- `EXACT_REVIEW_PUBLICATION_RECOVERY_SUCCESSES` overrides how many consecutive
  clean publications raise the adaptive publication ceiling by one step; the
  default is 10 (clamped 1-1000). The former hardcoded 50 pinned the lane at
  its minimum under hourly rate-limit bursts because the counter resets on
  every failure.
- `CLAWSWEEPER_MAINTAINER_LOGINS` (comma-separated) supplements the maintainer
  author-association check in the idea-archive revival watcher — needed where
  GitHub reports an org owner as `CONTRIBUTOR` on app-operated repositories. A
  qualifying maintainer or allowlisted author sponsors revival by commenting
  `@clawsweeper revive` (or `@clawsweeper sponsor`) on the closed issue.
- `CLAWSWEEPER_IDEA_REVIVAL_REACTIONS` overrides the positive-reaction threshold
  for reopening an issue parked with `clawsweeper:idea-archive`; the default is 5.
- `CLAWSWEEPER_IDEA_ARCHIVE_SCAN_PAGES` overrides the bounded created-order scan
  page count; the default is 5 and the maximum is 10. The watcher first checks
  the two most recently updated pages for sponsorship commands, then alternates
  newest/oldest created-order scans. Reaction-only revival can lag in very large
  archives; raise this override to scan deeper per run.
- `REVIEW_PLACEHOLDER_MAX_CHECKS` overrides the number of search candidates
  examined per open and closed state class by each 15-minute
  orphaned-placeholder recovery pass; the default is 20 and the maximum is 1000. Independent durable cursors rotate both state classes so non-actionable
  matches cannot permanently pin later placeholders behind the bounded pass.
- `REVIEW_PLACEHOLDER_MIN_AGE_HOURS` overrides how old the latest ClawSweeper bot
  review-start placeholder must be before recovery; the default is 2 hours and
  the maximum is 720 hours.
- `REVIEW_PLACEHOLDER_MAX_RECOVERIES` overrides the number of orphaned review
  placeholders enqueued per recovery pass; the default is 5 and the maximum is 100.
- Placeholder recovery logs GitHub Search `matched` and derived `remaining`
  counts for backlog telemetry. Search counts can lag comment mutations, so
  only failed cleanup or enqueue actions for live-verified orphans make the
  scheduled run fail.
- `EXACT_REVIEW_DISPATCH_DEBOUNCE_MS` overrides the 90,000 ms coalescing delay
  for fresh non-command exact-review events.
- `EXACT_REVIEW_DISPATCH_DEBOUNCE_MAX_MS` overrides the 180,000 ms maximum
  coalescing window measured from the item's first enqueue.
- `EXACT_REVIEW_PENDING_SOFT_LIMIT` overrides the pending-depth threshold for
  shedding new recovery and scheduled exact-review work; the default is 300.
- `EXACT_REVIEW_TARGET_RATE_PER_HOUR` sets the fleet-wide review
  admission target; the default is 200, organic reviews consume it first, and
  the scheduled remainder is split 35/65 between hot intake and normal backfill.
- `EXACT_REVIEW_TARGET_BURST` bounds the scheduled admission burst; the
  default is 50 and uses the same lane split.
- Scheduled planners subtract active and pending review work from the 128-slot
  review capacity before selecting candidates. Target fanout gives every
  cursor-selected repository a one-candidate floor, then apportions the
  remaining free capacity by untracked backlog.
- `EXACT_REVIEW_HEARTBEAT_GRACE_MS` overrides the 1,200,000 ms exact-review worker heartbeat
  grace. It is clamped to at least 420,000 ms so a configured grace can never dip
  near the one-minute worker heartbeat interval during scheduler or network stalls.
- `CLAWSWEEPER_FEATURE_CLUSTER_REPAIR_ENABLED=1` enables the scheduled
  `repair-cluster-intake.yml` imported-cluster intake. Direct repair import and
  dispatch commands are not blocked by this variable; they keep the existing
  repair execution gates. The selector model compares live evidence for a batch
  of unprocessed clusters and chooses one cluster or rejects the batch. Candidate
  quality is not decided by word lists, scores, or semantic thresholds.
- `CLAWSWEEPER_CLUSTER_REPAIR_CANDIDATE_BATCH` controls how many unprocessed
  clusters the scheduled selector model compares. The default is `8`; the model
  still selects at most one cluster. The upstream gitcrawl-store refreshes every
  15 minutes. Intake durably publishes the selected job, store identity, the
  model's per-cluster decisions and rationale, and stable dispatch key before
  dispatch. Decisions persist in a versioned sidecar so the
  strict v2 dispatch ledger remains backward-compatible with in-flight readers.
  Rejected cluster IDs are therefore not offered again on the next store
  snapshot. A cluster with one live candidate may be offered when its other
  members provide useful context; the model remains the usefulness judge. The
  intake owner recovers pending dispatch before accepting new work without
  duplicating completed worker execution.
- `CLAWSWEEPER_MAX_LIVE_WORKERS` overrides the `job_intent`-derived repair
  dispatch cap.
- `CLAWSWEEPER_AUTOMERGE_MAX_LIVE_WORKERS` overrides
  `repair_live_runs.automerge_default`.
- `CLAWSWEEPER_AUTO_IMPLEMENT_MAX_LIVE_WORKERS` overrides
  `repair_live_runs.issue_implementation_default`.
- `CLAWSWEEPER_AUTO_IMPLEMENT_MAX_DISPATCH_PER_SWEEP` overrides
  `issue_implementation.dispatches_per_sweep_default`.
- Each enabled automatic issue intake lane scans durable open reports and
  dispatches at most `issue_implementation.dispatches_per_sweep_default`
  candidates per target sweep.
- Manual `sweep.yml` dispatch `shard_count` overrides
  `review_shards.normal_default`, then clamps to `review_shards.hard_cap`.
