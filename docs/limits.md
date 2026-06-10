# Automation Limits

Read when changing ClawSweeper throughput, Codex fan-out, commit review paging,
or repair dispatch capacity.

`config/automation-limits.json` is the source of truth for the global worker
budget. It deliberately has only one main knob, `workers.max`, because that is
the number we normally tune when Codex or GitHub rate limits get tight. Most
lane-specific limits are derived from that budget; safety thresholds such as
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
- Background lanes shrink when priority work is already active.
- Runtime overrides are escape hatches, not the normal tuning surface.

## Worker Budget

| Name | Current | Meaning |
| --- | ---: | --- |
| `workers.max` | 8 | Maximum global Codex worker budget used to derive lane limits. |
| `workers.reserve_for_interactive` | 2 | Worker slots background lanes leave open for exact/manual/urgent work. |
| `workers.expansion_reserve` | 2 | Extra slots background lanes leave open for independently planned matrix expansion. |
| `workers.minimum_background` | 1 | Target floor for background progress when enough global capacity is available. |

## Derived Limits

Derived limits are intentionally percentages of `workers.max`. With
`workers.max = 8`, normal review can use 5 workers, hot intake can use 2,
commit review can use 1 commit per page, and repair lanes can dispatch 3 live
workers.

| Name | Current | Meaning |
| --- | ---: | --- |
| `review_shards.normal_default` | 5 | Quiet-system normal review shard ceiling. |
| `review_shards.normal_active_floor` | 2 | Minimum active normal review shards to keep queued for `openclaw/openclaw`. |
| `review_shards.hot_intake_default` | 2 | Quiet-system broad hot-intake review shard ceiling. |
| `review_shards.exact_item_default` | 1 | Exact-item hot-intake shard count. |
| `review_shards.hard_cap` | 8 | Maximum accepted review shard count. |
| `commit_review.page_size_default` | 1 | Commits selected per commit-review page. |
| `commit_review.page_size_hard_cap` | 8 | Maximum commit-review page size. |
| `repair_live_runs.default` | 3 | Default live repair workflow run cap for manual dispatch/requeue/self-heal. |
| `repair_live_runs.hard_cap` | 8 | Absolute live repair run cap accepted by the CLI. |
| `repair_live_runs.automerge_default` | 3 | Live repair run cap for automerge comment-router dispatches. |
| `repair_live_runs.issue_implementation_default` | 3 | Live repair run cap for issue-to-PR implementation intake. |
| `issue_implementation.dispatches_per_sweep_default` | 1 | Maximum implementation intake jobs queued from one review publish run. |

Formula summary:

- normal review: 70% of `workers.max`
- normal active floor: 30% of `workers.max`
- hot intake: 35% of `workers.max`
- commit review page size: 5% of `workers.max`
- repair, automerge repair, and issue implementation: 40% of `workers.max`
- issue implementation dispatches per sweep: 4% of `workers.max`
- hard caps: `workers.max`

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

- Quiet system: manual normal review can request 5 shards; scheduled normal
  review gets 4 after reserving 2 slots for exact/manual/urgent work and 2
  slots for in-flight matrix expansion.
- 2 active repair workers and 1 active background worker: normal review gets
  1 because `8 - 2 interactive reserve - 2 expansion reserve - 2 priority
  - 1 background = 1`.
- 4 active priority workers: commit review gets 1, so commit review yields but
  does not fully stall.

Use these commands to inspect the effective values from a checkout:

```bash
pnpm run --silent workflow -- worker-config
pnpm run --silent workflow -- limit review_shards.normal_default
pnpm run --silent workflow -- worker-limit normal_review
pnpm run --silent workflow -- worker-limit commit_review --active-critical 64
```

Change `workers.max` first when tuning rate-limit pressure. For example, setting
`workers.max` to `10` automatically makes normal review `7`, hot intake `3`,
commit review `1`, repair `4`, and hard caps `10`.

## Runtime Overrides

- `CLAWSWEEPER_COMMIT_REVIEW_PAGE_SIZE` overrides
  `commit_review.page_size_default`.
- `CLAWSWEEPER_MAX_LIVE_WORKERS` overrides the `job_intent`-derived repair
  dispatch cap.
- `CLAWSWEEPER_AUTOMERGE_MAX_LIVE_WORKERS` overrides
  `repair_live_runs.automerge_default`.
- `CLAWSWEEPER_AUTO_IMPLEMENT_MAX_LIVE_WORKERS` overrides
  `repair_live_runs.issue_implementation_default`.
- `CLAWSWEEPER_AUTO_IMPLEMENT_MAX_DISPATCH_PER_SWEEP` overrides
  `issue_implementation.dispatches_per_sweep_default`.
- Manual `sweep.yml` dispatch `shard_count` overrides
  `review_shards.normal_default`, then clamps to `review_shards.hard_cap`.
