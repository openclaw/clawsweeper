# ClawSweeper

ClawSweeper is a conservative OpenClaw maintainer bot. It reviews open issues and PRs in `openclaw/openclaw`, writes one regenerated markdown record per open item, and closes only when the evidence is strong.

Allowed close reasons:

- already implemented on `main`
- cannot reproduce on current `main`
- belongs on ClawHub as a skill/plugin, not in core
- too incoherent to be actionable
- stale issue older than 60 days with insufficient data to verify the bug

Everything else stays open.

## Dashboard

Last dashboard update: Apr 25, 2026, 13:50 UTC

<!-- clawsweeper-status:start -->
### Workflow Status

Updated: Apr 25, 2026, 13:50 UTC

State: Apply in progress

Checkpoint 4 finished. Fresh closes in checkpoint: 50. Total fresh closes in this run: 200/500. Result records in checkpoint: 52.
Run: [https://github.com/openclaw/clawsweeper/actions/runs/24931927101](https://github.com/openclaw/clawsweeper/actions/runs/24931927101)
<!-- clawsweeper-status:end -->

| Metric | Count |
| --- | ---: |
| Open issues in [openclaw/openclaw](https://github.com/openclaw/openclaw) | 7308 |
| Fresh reviewed issues in the last 7 days | 7270 |
| Proposed issue closes | 1691 (23.3% of reviewed issues) |
| Open PRs in [openclaw/openclaw](https://github.com/openclaw/openclaw) | 4791 |
| Fresh reviewed PRs in the last 7 days | 4716 |
| Proposed PR closes | 343 (7.3% of reviewed PRs) |
| Open items total | 12099 |
| Reviewed files | 11997 |
| Unreviewed open items | 102 |
| Archived closed files | 7150 |
| Fresh verified reviews in the last 7 days | 11986 |
| Proposed closes awaiting apply | 2034 (17% of fresh reviews) |
| Closed by Codex apply | 5307 |
| Failed or stale reviews | 11 |
| Daily cadence coverage | 8979/9225 current (246 due, 97.3%) |
| Daily PR cadence | 4480/4720 current (240 due, 94.9%) |
| Daily new issue cadence (<30d) | 4499/4505 current (6 due, 99.9%) |
| Weekly older issue cadence | 2771/2772 current (1 due, 100%) |
| Due now by cadence | 349 |

Recently reviewed:

| Item | Title | Outcome | Status | Reviewed |
| --- | --- | --- | --- | --- |
| [#64157](https://github.com/openclaw/openclaw/issues/64157) | [Bug]: Multi-Surface Message Routing Failure — Replies lost when switching from Feishu to Web Control UI mid-conversation | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/64157.md) | complete | Apr 25, 2026, 13:00 UTC |
| [#71571](https://github.com/openclaw/openclaw/issues/71571) | Agent-level model field ignored during session creation — falls back to global default | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/71571.md) | complete | Apr 25, 2026, 12:59 UTC |
| [#63235](https://github.com/openclaw/openclaw/issues/63235) | 功能优化 | [close / proposed_close](https://github.com/openclaw/clawsweeper/blob/main/items/63235.md) | complete | Apr 25, 2026, 12:59 UTC |
| [#66360](https://github.com/openclaw/openclaw/issues/66360) | session.maintenance has no size cap for transcript .jsonl files — unbounded growth causes gateway CPU 100% | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/66360.md) | complete | Apr 25, 2026, 12:59 UTC |
| [#71562](https://github.com/openclaw/openclaw/issues/71562) | System attempting to JSON-parse Markdown (.md) files in workspace context | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/71562.md) | complete | Apr 25, 2026, 12:58 UTC |
| [#56437](https://github.com/openclaw/openclaw/issues/56437) | [Feature Request] Native fallbackRunbook injection in agents config | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/56437.md) | complete | Apr 25, 2026, 12:58 UTC |
| [#69501](https://github.com/openclaw/openclaw/issues/69501) | memory subcommands (status / index / search / promote) hang indefinitely with no output on Linux containers | [close / proposed_close](https://github.com/openclaw/clawsweeper/blob/main/items/69501.md) | complete | Apr 25, 2026, 12:58 UTC |
| [#48136](https://github.com/openclaw/openclaw/issues/48136) | fix(acpx): ACP bridge passes OpenClaw agent ID instead of runtime.acp.agent to ACPX harness | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/48136.md) | complete | Apr 25, 2026, 12:58 UTC |
| [#66540](https://github.com/openclaw/openclaw/issues/66540) | replyToCurrent default false blocks implicit replyToId in followup queue | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/66540.md) | complete | Apr 25, 2026, 12:58 UTC |
| [#52275](https://github.com/openclaw/openclaw/pull/52275) | [codex] fix(outbound): preserve delivery queue recovery metadata | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/52275.md) | complete | Apr 25, 2026, 12:57 UTC |
| [#52236](https://github.com/openclaw/openclaw/pull/52236) | fix(mattermost): persist threadId in delivery context for all session types | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/52236.md) | complete | Apr 25, 2026, 12:57 UTC |
| [#52571](https://github.com/openclaw/openclaw/pull/52571) | fix: suppress reminder guard for sweep-backed reminders | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/52571.md) | complete | Apr 25, 2026, 12:57 UTC |
| [#65976](https://github.com/openclaw/openclaw/issues/65976) | memory-wiki bridge mode reports zero public artifacts and can remove existing bridge pages even when QMD memory is healthy | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/65976.md) | complete | Apr 25, 2026, 12:57 UTC |
| [#71575](https://github.com/openclaw/openclaw/issues/71575) | Telegram channel renders intermediate tool call steps as visible messages | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/71575.md) | complete | Apr 25, 2026, 12:57 UTC |
| [#66768](https://github.com/openclaw/openclaw/issues/66768) | [Bug]: Empty completed turns in ghcr.io/openclaw/openclaw:2026.4.14 | [close / proposed_close](https://github.com/openclaw/clawsweeper/blob/main/items/66768.md) | complete | Apr 25, 2026, 12:57 UTC |
| [#71569](https://github.com/openclaw/openclaw/issues/71569) | Mattermost streaming config: documented but not implemented + notification UX bug | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/71569.md) | complete | Apr 25, 2026, 12:57 UTC |
| [#52276](https://github.com/openclaw/openclaw/pull/52276) | [codex] fix(dedupe): preserve route-scoped suppression context | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/52276.md) | complete | Apr 25, 2026, 12:57 UTC |
| [#62531](https://github.com/openclaw/openclaw/issues/62531) | [Feature] Add option to configure wizard to add provider models without changing primary model | [close / proposed_close](https://github.com/openclaw/clawsweeper/blob/main/items/62531.md) | complete | Apr 25, 2026, 12:57 UTC |
| [#63254](https://github.com/openclaw/openclaw/issues/63254) | Replay/dedup bug can redeliver prior cron and Matrix events into the same session | [close / proposed_close](https://github.com/openclaw/clawsweeper/blob/main/items/63254.md) | complete | Apr 25, 2026, 12:57 UTC |
| [#64911](https://github.com/openclaw/openclaw/issues/64911) | Gateway logs ready before websocket control plane is usable; immediate CLI RPCs can time out after restart | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/64911.md) | complete | Apr 25, 2026, 12:57 UTC |

## How It Works

The normal workflow is proposal-only. It runs configurable parallel shards and never comments or closes unless `apply_closures=true` is explicitly set for a manual run.

Each review job:

1. Checks out this repo.
2. Uses a planner job that scans open items, prioritizes due activity, and hands explicit item-number batches to review shards.
3. Checks out `openclaw/openclaw` at `main`, with cached git objects for faster startup.
4. Runs Codex with `gpt-5.4`, medium reasoning, fast service tier, and a 10-minute per-item timeout inside the OpenClaw checkout.
5. Writes `items/<number>.md` with the decision, proposed close comment, and a GitHub snapshot hash.
6. Marks high-confidence allowed close decisions as `proposed_close`.

Codex runs without GitHub write tokens. The runner checks the OpenClaw checkout before every review, makes the checkout read-only in CI, checks it again after review, and fails the item if Codex leaves any tracked or untracked change behind.

Parallel workflow shards only receive planned item numbers. The planner posts a best-effort workflow status note to this README before shards start, each shard emits `[review]` progress lines, and the final job merges artifacts and updates the dashboard. Review jobs time out after 75 minutes so one stuck shard cannot hold the review concurrency group indefinitely. If the planner filled the current worker capacity, the publish job dispatches the next proposal-only sweep automatically. Review cadence is daily for items with activity since the last stored snapshot, all PRs, and issues younger than 30 days. Older inactive issues are reviewed weekly. When more items are due than fit in a run, the planner prioritizes active items first, then PRs, then new issues, then older weekly reviews. The dashboard reports local cadence coverage for daily PRs, daily new issues, and weekly older issues; activity-based promotion is applied by the planner while scanning GitHub snapshots.

To close later without rerunning Codex, dispatch the workflow with `apply_existing=true`. That mode reads existing `items/*.md`, refetches the issue/PR context, recomputes the snapshot hash, and only comments/closes if nothing changed since the proposal was written. Successfully closed or already-closed items move to `closed/<number>.md`; `items/` stays focused on open items that still need tracking. Folder reconciliation also compares tracked files with the current GitHub open set: externally closed items move from `items/` to `closed/`, and reopened archived items move back to `items/` as stale so the planner reviews them again. Apply runs update the dashboard when each checkpoint commits, cap total processed items separately from fresh closes, leave enough scan room to skip changed or already-closed records while still reaching fresh closures, and emit `[apply]` progress lines during long close batches. Apply mode also posts best-effort start/checkpoint/finish notes to the dashboard. When GitHub secondary throttling triggers a long retry sleep, apply mode posts a best-effort throttle heartbeat to the dashboard with the checkpoint, processed count, and next retry delay. Apply mode defaults to `apply_min_age_days=0`, `apply_kind=issue`, a 5-second close delay, 50 fresh closes per checkpoint commit, and long retry backoff for GitHub secondary write throttling, so issue cleanup can apply high-confidence closes regardless of age while PRs remain excluded. If an apply run reaches its requested close limit, it queues another apply run with the same settings.

Maintainer-authored items are never auto-closed. Candidate planning and apply mode both read GitHub's `author_association` field and exclude `OWNER`, `MEMBER`, and `COLLABORATOR` items from automated close actions.

## Local Run

Requires Node 24.

```bash
source ~/.profile
npm install
npm run build
npm run plan -- --batch-size 5 --shard-count 40 --max-pages 250 --codex-model gpt-5.4 --codex-reasoning-effort medium --codex-service-tier fast
npm run review -- --openclaw-dir ../openclaw --batch-size 5 --max-pages 250 --artifact-dir artifacts/reviews --codex-model gpt-5.4 --codex-reasoning-effort medium --codex-service-tier fast --codex-timeout-ms 600000
npm run apply-artifacts -- --artifact-dir artifacts/reviews
npm run reconcile -- --dry-run
```

Apply unchanged proposals later:

```bash
source ~/.profile
npm run apply-decisions -- --limit 20
```

Manual review runs can set `--apply-closures` or workflow input `apply_closures=true`, but the safer path is proposal first, then `apply_existing=true`.

## Checks

```bash
npm run check
npm run oxformat
```

`oxformat` is an alias for `oxfmt`; there is no separate `oxformat` npm package.

## GitHub Actions Setup

Required secrets:

- `OPENAI_API_KEY`: OpenAI API key used to log Codex in before review shards run.
- `CODEX_API_KEY`: optional compatibility alias for the same key during the login check.
- `OPENCLAW_GH_TOKEN`: GitHub token with write access to `openclaw/openclaw` issues and PRs.

The workflow logs Codex in with `OPENAI_API_KEY`, then runs review shards without OpenAI or Codex API key environment variables. `codex exec` uses the prepared login state, and the shard fails instead of writing fallback review markdown if Codex auth/output fails. It uses `OPENCLAW_GH_TOKEN` for `openclaw/openclaw` comments/closes. The built-in `GITHUB_TOKEN` commits review markdown back to this repo.
