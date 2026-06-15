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

GitHub repository variables still override selected live limits. When a variable
is unset, workflows read the checked-in budget after checkout. The one exception
is the `workflow_dispatch.inputs.shard_count.default` value in
`.github/workflows/sweep.yml`: GitHub renders that UI before checkout, so it
must remain a YAML literal. `pnpm run check:limits` verifies that literal and the
docs stay in sync with the derived budget.

The mental model:

- `workers.max` is the global Codex capacity budget.
- Priority lanes are repair, issue implementation, and exact-item review.
- Background lanes are normal review, hot intake, and commit review.
- Assist has a small fixed cap because it is lightweight maintainer Q&A, not a
  derived review or repair lane.
- Background lanes shrink when priority work is already active.
- Runtime overrides are escape hatches, not the normal tuning surface.

## Worker Budget

| Name | Current | Meaning |
| --- | ---: | --- |
| `workers.max` | 128 | Maximum global Codex worker budget used to derive lane limits. |
| `workers.reserve_for_interactive` | 32 | Worker slots background lanes leave open for exact/manual/urgent work. |
| `workers.expansion_reserve` | 32 | Extra slots background lanes leave open for independently planned matrix expansion. |
| `workers.minimum_background` | 16 | Target floor for background progress when enough global capacity is available. |
| `lanes.assist.max` | 10 | Maximum concurrent lightweight assist jobs. |
| `lanes.repair.cluster_max_live_runs` | 2 | Default live repair workflow cap for imported gitcrawl cluster dispatches. |

## Derived Limits

Review, commit, and existing repair limits are intentionally percentages of
`workers.max`; imported cluster repair has its own lane knob. With
`workers.max = 128`, normal review can use 89 workers, hot intake can use 44,
commit review can use 6 commits per page, existing repair lanes dispatch 51
live workers by default, and imported cluster repair dispatches two live workers
by default.

| Name | Current | Meaning |
| --- | ---: | --- |
| `assist.default` | 10 | Maintainer assist job cap. |
| `review_shards.normal_default` | 89 | Quiet-system normal review shard ceiling. |
| `review_shards.normal_active_floor` | 38 | Minimum active normal review shards to keep queued for `openclaw/openclaw`. |
| `review_shards.hot_intake_default` | 44 | Quiet-system broad hot-intake review shard ceiling. |
| `review_shards.exact_item_default` | 1 | Exact-item hot-intake shard count. |
| `review_shards.hard_cap` | 128 | Maximum accepted review shard count. |
| `commit_review.page_size_default` | 6 | Commits selected per commit-review page. |
| `commit_review.page_size_hard_cap` | 128 | Maximum commit-review page size. |
| `repair_live_runs.default` | 51 | Default live repair workflow run cap for manual dispatch/requeue/self-heal. |
| `repair_live_runs.hard_cap` | 128 | Absolute live repair run cap accepted by explicit CLI/env overrides with this config. |
| `repair_live_runs.automerge_default` | 51 | Live repair run cap for automerge comment-router dispatches. |
| `repair_live_runs.issue_implementation_default` | 51 | Live repair run cap for issue-to-PR implementation intake. |
| `repair_live_runs.cluster_default` | 2 | Live repair run cap for imported gitcrawl cluster dispatches. |
| `issue_implementation.dispatches_per_sweep_default` | 5 | Maximum implementation intake jobs queued from one review publish run. |

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

Background sweeps that are still planning or expanding their matrix reserve
their quiet lane size. That avoids a race where a second background planner sees
the first run before its shard jobs exist and over-allocates the shared Codex
budget. Broad manual review `shard_count` inputs are also capped by the current
lane allowance; exact-item runs still use the exact-item lane.

Priority lanes do not subtract the interactive reserve. They cap themselves at
their derived lane ceiling and at the remaining global budget after other active
priority work.

Examples with the current config:

- Quiet system: manual normal review can request 89 shards; scheduled normal
  review gets 64 after reserving 32 slots for exact/manual/urgent work and 32
  slots for in-flight matrix expansion.
- 4 active repair workers and 68 active background workers: normal review gets
  1 because `128 - 32 interactive reserve - 32 expansion reserve - 4 priority
  - 68 background = -8`, and enabled background lanes keep one slow-progress worker.
- 88 active priority workers: commit review gets 1, so commit review yields but
  does not fully stall.

Use these commands to inspect the effective values from a checkout:

```bash
pnpm run --silent workflow -- worker-config
pnpm run --silent workflow -- limit review_shards.normal_default
pnpm run --silent workflow -- worker-limit normal_review
pnpm run --silent workflow -- worker-limit commit_review --active-critical 88
```

Change `workers.max` first when tuning review-side rate-limit pressure. For
example, setting `workers.max` to `90` automatically makes normal review `63`,
hot intake `31`, and commit review `4`. Existing repair lanes keep their
40% derived caps, while imported cluster repair remains separately bounded until
`lanes.repair.cluster_max_live_runs` is raised.

## Runtime Overrides

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
