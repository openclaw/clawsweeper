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
| `workers.max` | 100 | Maximum global Codex worker budget used to derive lane limits. |
| `workers.reserve_for_interactive` | 10 | Worker slots background lanes leave open for exact/manual/urgent work. |
| `workers.minimum_background` | 10 | Target floor for background progress when enough global capacity is available. |

## Derived Limits

Derived limits are intentionally percentages of `workers.max`, except normal
review, which uses the full configured budget when explicitly requested. With
`workers.max = 100`, the quiet-system ceilings are easy to read directly:
normal review can use 100 workers, hot intake can use 35, commit review can use
5 commits per page, and repair lanes can dispatch 40 live workers.

| Name | Current | Meaning |
| --- | ---: | --- |
| `review_shards.normal_default` | 100 | Quiet-system normal review shard ceiling. |
| `review_shards.normal_active_floor` | 30 | Minimum active normal review shards to keep queued for `openclaw/openclaw`. |
| `review_shards.hot_intake_default` | 35 | Quiet-system broad hot-intake review shard ceiling. |
| `review_shards.exact_item_default` | 1 | Exact-item hot-intake shard count. |
| `review_shards.hard_cap` | 100 | Maximum accepted review shard count. |
| `commit_review.page_size_default` | 5 | Commits selected per commit-review page. |
| `commit_review.page_size_hard_cap` | 100 | Maximum commit-review page size. |
| `repair_live_runs.default` | 40 | Default live repair workflow run cap for manual dispatch/requeue/self-heal. |
| `repair_live_runs.hard_cap` | 100 | Absolute live repair run cap accepted by the CLI. |
| `repair_live_runs.automerge_default` | 40 | Live repair run cap for automerge comment-router dispatches. |
| `repair_live_runs.issue_implementation_default` | 40 | Live repair run cap for issue-to-PR implementation intake. |
| `issue_implementation.dispatches_per_sweep_default` | 4 | Maximum implementation intake jobs queued from one review publish run. |

Formula summary:

- normal review: 100% of `workers.max`
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
5. cap the result at the lane's derived quiet-system ceiling
6. return at least 1 so an enabled lane can still make slow progress

Priority lanes do not subtract the interactive reserve. They cap themselves at
their derived lane ceiling and at the remaining global budget after other active
priority work.

Examples with the current config:

- Quiet system: manual normal review can request 100 shards; scheduled normal
  review gets 90 after reserving 10 slots for exact/manual/urgent work.
- 30 active repair workers and 20 active background workers: normal review gets
  40 because `100 - 10 reserve - 30 priority - 20 background = 40`.
- 90 active priority workers: commit review gets 1, so commit review yields but
  does not fully stall.

Use these commands to inspect the effective values from a checkout:

```bash
pnpm run --silent workflow -- worker-config
pnpm run --silent workflow -- limit review_shards.normal_default
pnpm run --silent workflow -- worker-limit normal_review
pnpm run --silent workflow -- worker-limit commit_review --active-critical 90
```

Change `workers.max` first when tuning rate-limit pressure. For example, setting
`workers.max` to `80` automatically makes normal review `80`, hot intake `28`,
commit review `4`, repair `32`, and hard caps `80`.

## Runtime Overrides

- `CLAWSWEEPER_COMMIT_REVIEW_PAGE_SIZE` overrides
  `commit_review.page_size_default`.
- `CLAWSWEEPER_MAX_LIVE_WORKERS` overrides `repair_live_runs.default`.
- `CLAWSWEEPER_AUTOMERGE_MAX_LIVE_WORKERS` overrides
  `repair_live_runs.automerge_default`.
- `CLAWSWEEPER_AUTO_IMPLEMENT_MAX_LIVE_WORKERS` overrides
  `repair_live_runs.issue_implementation_default`.
- `CLAWSWEEPER_AUTO_IMPLEMENT_MAX_DISPATCH_PER_SWEEP` overrides
  `issue_implementation.dispatches_per_sweep_default`.
- Manual `sweep.yml` dispatch `shard_count` overrides
  `review_shards.normal_default`, then clamps to `review_shards.hard_cap`.
