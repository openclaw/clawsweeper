# Automation Limits

Read when changing ClawSweeper throughput, Codex fan-out, commit review paging,
or repair dispatch capacity.

`config/automation-limits.json` is the source of truth for the global worker
budget. It deliberately has one main global knob, `workers.max`, because that is
the number we normally tune when Codex or GitHub rate limits get tight. Most
lane-specific limits are derived from that budget; imported cluster repair has
a separate explicit knob so it can stay tightly bounded unless a maintainer
intentionally opens it wider. Safety thresholds such as
close age floors, apply delays, retry counts, and comment caps stay near the
code that owns those decisions.

The default-off per-author PR-budget policy follows that safety-threshold rule.
Its tunables live beside the apply policy rather than in the global worker
budget:

| Environment variable                              | Default | Meaning                                              |
| ------------------------------------------------- | ------: | ---------------------------------------------------- |
| `CLAWSWEEPER_AUTHOR_PR_BUDGET_CLOSE_ENABLED`      | `false` | Enables live per-author budget closes.               |
| `CLAWSWEEPER_AUTHOR_PR_BUDGET`                    |      15 | Allowed open PRs per external author and repository. |
| `CLAWSWEEPER_AUTHOR_PR_BUDGET_MAX_CLOSES_PER_RUN` |       5 | Gradual trim cap per author in one apply run.        |

See [`author-pr-budget-close-policy.md`](author-pr-budget-close-policy.md) for
the rating, proof, inactivity, engagement, and fail-closed gates.

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
- Background lanes are normal review, hot intake, and commit review.
- Assist has a small fixed cap because it is lightweight maintainer Q&A, not a
  derived review or repair lane.
- Background lanes shrink when priority work is already active.
- Runtime overrides are escape hatches, not the normal tuning surface.

## Worker Budget

| Name                                       | Current | Meaning                                                                               |
| ------------------------------------------ | ------: | ------------------------------------------------------------------------------------- |
| `workers.max`                              |     128 | Maximum global Codex worker budget used to derive lane limits.                        |
| `workers.reserve_for_interactive`          |      16 | Worker slots background lanes leave open for exact/manual/urgent work.                |
| `workers.expansion_reserve`                |       8 | Extra slots background lanes leave open for independently planned matrix expansion.   |
| `workers.minimum_background`               |      16 | Target floor for background progress when enough global capacity is available.        |
| `lanes.exact_review.max_concurrent`        |      64 | Maximum concurrent exact-item review workflow runs admitted to Codex.                 |
| `lanes.exact_review.target_max_concurrent` |      60 | Maximum concurrent exact-item review workflow runs one target repository may consume. |
| `lanes.assist.max`                         |      10 | Maximum concurrent lightweight assist jobs.                                           |
| `lanes.repair.cluster_max_live_runs`       |       2 | Default live repair workflow cap for imported gitcrawl cluster dispatches.            |

## Derived Limits

Review, commit, and existing repair limits are intentionally percentages of
`workers.max`; imported cluster repair has its own lane knob. With
`workers.max = 128`, normal review can use 89 workers, hot intake can use 44,
commit review can use 6 commits per page, existing repair lanes dispatch 51
live workers by default, and imported cluster repair dispatches two live workers
by default.

| Name                                                | Current | Meaning                                                                               |
| --------------------------------------------------- | ------: | ------------------------------------------------------------------------------------- |
| `exact_review.concurrent_max`                       |      64 | Exact-item review admission cap, clamped to `workers.max`.                            |
| `exact_review.target_concurrent_max`                |      60 | Exact-item per-target admission cap, clamped to global exact-review capacity.         |
| `assist.default`                                    |      10 | Maintainer assist job cap.                                                            |
| `review_shards.normal_default`                      |      89 | Quiet-system normal review shard ceiling.                                             |
| `review_shards.normal_active_floor`                 |      38 | Minimum active normal review shards to keep queued for `openclaw/openclaw`.           |
| `review_shards.hot_intake_default`                  |      44 | Quiet-system broad hot-intake review shard ceiling.                                   |
| `review_shards.exact_item_default`                  |       1 | Exact-item hot-intake shard count.                                                    |
| `review_shards.hard_cap`                            |     128 | Maximum accepted review shard count.                                                  |
| `commit_review.page_size_default`                   |       6 | Commits selected per commit-review page.                                              |
| `commit_review.page_size_hard_cap`                  |     128 | Maximum commit-review page size.                                                      |
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
- commit review page size: 5% of `workers.max`
- repair, automerge repair, and issue implementation: 40% of `workers.max`
- imported cluster repair: `lanes.repair.cluster_max_live_runs`, clamped to
  `workers.max`
- issue implementation dispatches per sweep: 4% of `workers.max`
- review/commit hard caps: `workers.max`
- repair hard cap: `workers.max`

## Dynamic Scheduling

Normal review, hot intake, and commit review are background lanes. Before they
dispatch, the workflow asks `pnpm run workflow -- worker-limit <lane>` for the
current allowance.

The scheduler does this for background lanes:

1. start with `workers.max`
2. subtract active priority work, currently repair workers plus exact-item sweep
   runs
3. subtract active background work already known to the workflow, including
   commit-review pages and other active normal/hot sweep runs
4. reserve `workers.reserve_for_interactive`
5. reserve `workers.expansion_reserve` for independently planned matrix waves
6. cap the result at the lane's derived quiet-system ceiling
7. return at least 1 so an enabled lane can still make slow progress

The normal result is then reduced when the exact-review queue is under pressure.
Each planner reads the public, unauthenticated `GET /api/exact-review-queue`
endpoint once and uses its top-level pending count and oldest-pending age. A
failed, timed-out, or malformed response is treated as no pressure so a dashboard
outage cannot stall reviews.

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

Only normal review, hot intake, and commit review use this pressure multiplier.
Repair, assist, issue implementation, cluster repair, and exact-item review keep
their existing priority budgets.

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
workflow at once; the default is 64. `EXACT_REVIEW_TARGET_MAX_CONCURRENT` bounds
how many of those slots one target repository may consume; production sets it
to 60 so other target repositories retain four global slots during an OpenClaw
backlog drain. Exact capacity is consumed only while queue work is pending. As
those priority workers start, normal, hot-intake, and commit-review planners
count them and reduce their next background wave.

Fresh webhook work waits for `EXACT_REVIEW_DISPATCH_DEBOUNCE_MS` (45 seconds by
default) so rapid edits and pushes coalesce before dispatch. Repeated pending
revisions extend that delay up to `EXACT_REVIEW_DISPATCH_DEBOUNCE_MAX_MS` (three
minutes by default) from the item's first enqueue. Explicit command work and
publication work bypass the delay. When pending depth reaches
`EXACT_REVIEW_PENDING_SOFT_LIMIT` (300 by default), new recovery-only work is
shed; existing items, webhook events, commands, and publications remain admitted.

Exact-review result publication has a separate 24-workflow Actions lane. Its
checkout, artifact handling, comment sync, and result routing are deterministic
control-plane work: they consume GitHub runners, but not Codex slots. The
comment router and the singleton lease reconciler follow the same accounting
rule. Dashboard Codex capacity therefore counts only jobs whose steps execute
Codex and does not deduct these control-plane workflows from `workers.max`.

Each dispatched workflow claims its opaque lease before checkout. Protocol v2
binds claim and completion to the item key, lease revision, run attempt, claim
generation, and an immutable decision snapshot. During the rolling-upgrade
window, dispatches nest the strict tuple under `queue_claim`, also carry the immutable v1 snapshot, and the Worker accepts
lease-id-only finalization only for claims recorded as protocol v1. Duplicate
dispatches and stale workflows cannot claim the same lease, and a completion
immediately schedules a known newer revision. Failed and cancelled executors
requeue their item with bounded retry backoff. Successful finalizer reports stay
leased until a signed terminal-run reconciliation backstop confirms that exact
GitHub attempt completed successfully; this backstop can also recover terminal
failed or cancelled runs before lease expiry. Completion triggers share one
running and one pending reconciler; each surviving run inspects every live claim
against bounded workflow-run pages, then verifies only matching terminal attempts.
Candidates absent from those pages fall back to exact run lookup. This keeps
steady-state GitHub API work constant without losing an older claim, while a
terminal burst does not consume one Actions runner per review. Unclaimed
dispatches expire after six minutes and receive a new opaque lease; delayed
workflows holding the expired lease cannot claim it.
Run-attempt binding and a per-claim generation check keep delayed terminal
decisions from releasing a later rerun; queued and in-progress runs are never
released. If a workflow never claims or completes, the Durable Object reclaims
the expired lease. Claimed review workers heartbeat every five minutes; after the first
heartbeat, `EXACT_REVIEW_HEARTBEAT_GRACE_MS` bounds liveness to 20 minutes by default while
never extending the original 130-minute execution lease. Leases created before heartbeat
support was deployed retain their original execution expiry. This keeps capacity waiting and
retry state out of GitHub Actions runners.

Examples with the current config:

- Quiet system: scheduled and manual normal review can request 89 shards, with
  104 background slots available after reserving 16 for interactive work and 8
  for matrix expansion.
- 4 active repair workers and 96 active background workers: normal review gets
  4 because `128 - 16 interactive reserve - 8 expansion reserve - 4 priority
  - 96 background = 4`.
- 105 active priority workers: commit review gets 1, so commit review yields but
  does not fully stall.

Use these commands to inspect the effective values from a checkout:

```bash
pnpm run --silent workflow -- worker-config
pnpm run --silent workflow -- limit review_shards.normal_default
pnpm run --silent workflow -- worker-limit normal_review
pnpm run --silent workflow -- worker-limit commit_review --active-critical 88
```

Change `workers.max` first when tuning review-side rate-limit pressure. For
example, setting `workers.max` to `40` automatically makes normal review `28`,
hot intake `14`, and commit review `2`. Existing repair lanes keep their
40% derived caps, while imported cluster repair remains separately bounded until
`lanes.repair.cluster_max_live_runs` is raised.

## Runtime Overrides

- `EXACT_REVIEW_DISPATCH_DEBOUNCE_MS` overrides the 45,000 ms coalescing delay
  for fresh non-command exact-review events.
- `EXACT_REVIEW_DISPATCH_DEBOUNCE_MAX_MS` overrides the 180,000 ms maximum
  coalescing window measured from the item's first enqueue.
- `EXACT_REVIEW_PENDING_SOFT_LIMIT` overrides the pending-depth threshold for
  shedding new recovery-only exact-review work; the default is 300.
- `EXACT_REVIEW_HEARTBEAT_GRACE_MS` overrides the 1,200,000 ms exact-review worker heartbeat
  grace. It is clamped to at least 420,000 ms so a configured grace can never dip
  below the five-minute worker heartbeat interval plus request time and jitter.
- `CLAWSWEEPER_COMMIT_REVIEW_PAGE_SIZE` overrides
  `commit_review.page_size_default`.
- `CLAWSWEEPER_FEATURE_CLUSTER_REPAIR_ENABLED=1` enables the scheduled
  `repair-cluster-intake.yml` imported-cluster intake. Direct repair import and
  dispatch commands are not blocked by this variable; they keep the existing
  repair execution gates. Gitcrawl cluster import also drip-feeds by default:
  clusters with at least 75% closed members are skipped unless
  `--skip-closed-percent` is overridden.
- `CLAWSWEEPER_CLUSTER_REPAIR_IMPORT_LIMIT` overrides the scheduled
  `repair-cluster-intake.yml` import limit. The default is `1` cluster per daily
  run; the upstream gitcrawl-store refreshes every 15 minutes, and ClawSweeper
  records the processed store SHA so repeated ticks against the same snapshot
  skip.
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
