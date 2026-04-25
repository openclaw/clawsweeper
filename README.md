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

Last dashboard update: Apr 25, 2026, 17:59 UTC

<!-- clawsweeper-status:start -->
### Workflow Status

Updated: Apr 25, 2026, 17:59 UTC

State: Review in progress

Planned 200 items across 40 shards. Capacity is 200 items. Review shards are starting; publish will merge artifacts when they finish.
Run: [https://github.com/openclaw/clawsweeper/actions/runs/24937018760](https://github.com/openclaw/clawsweeper/actions/runs/24937018760)
<!-- clawsweeper-status:end -->

| Metric | Count |
| --- | ---: |
| Open issues in [openclaw/openclaw](https://github.com/openclaw/openclaw) | 6110 |
| Fresh reviewed issues in the last 7 days | 5991 |
| Proposed issue closes | 586 (9.8% of reviewed issues) |
| Open PRs in [openclaw/openclaw](https://github.com/openclaw/openclaw) | 4507 |
| Fresh reviewed PRs in the last 7 days | 4401 |
| Proposed PR closes | 109 (2.5% of reviewed PRs) |
| Open items total | 10617 |
| Reviewed files | 10541 |
| Unreviewed open items | 76 |
| Archived closed files | 8701 |
| Fresh verified reviews in the last 7 days | 10392 |
| Proposed closes awaiting apply | 695 (6.7% of fresh reviews) |
| Closed by Codex apply | 6757 |
| Failed or stale reviews | 149 |
| Daily cadence coverage | 7430/7763 current (333 due, 95.7%) |
| Daily PR cadence | 4301/4442 current (141 due, 96.8%) |
| Daily new issue cadence (<30d) | 3129/3321 current (192 due, 94.2%) |
| Weekly older issue cadence | 2778/2778 current (0 due, 100%) |
| Due now by cadence | 409 |

Recently reviewed:

| Item | Title | Outcome | Status | Reviewed |
| --- | --- | --- | --- | --- |
| [#59409](https://github.com/openclaw/openclaw/issues/59409) | [Bug]: Feishu plugin: Chinese filenames in attachments display as garbled (Latin-1 encoding issue) | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/59409.md) | stale_local_checkout_blocked | Apr 25, 2026, 17:53 UTC |
| [#59528](https://github.com/openclaw/openclaw/issues/59528) | [Bug]: The bundled plugins openshell does not work correctly since version 2026.03.13 | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/59528.md) | stale_local_checkout_blocked | Apr 25, 2026, 17:52 UTC |
| [#59545](https://github.com/openclaw/openclaw/issues/59545) | [Bug]: macOS app General settings rewrites ~/.openclaw/openclaw.json without user changes | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/59545.md) | stale_local_checkout_blocked | Apr 25, 2026, 17:52 UTC |
| [#59567](https://github.com/openclaw/openclaw/issues/59567) | Feature Request: Heartbeat should only fire when session is idle | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/59567.md) | stale_local_checkout_blocked | Apr 25, 2026, 17:52 UTC |
| [#59405](https://github.com/openclaw/openclaw/issues/59405) | [Bug]: Telegram channel runtime drops exec/grep tool output for openai/gpt-5.1-codex | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/59405.md) | complete | Apr 25, 2026, 17:52 UTC |
| [#59576](https://github.com/openclaw/openclaw/issues/59576) | Mattermost: bot does not see file attachments (file_ids empty in WebSocket event) | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/59576.md) | stale_local_checkout_blocked | Apr 25, 2026, 17:52 UTC |
| [#59563](https://github.com/openclaw/openclaw/issues/59563) | [Bug] Session 数据丢失：对话中断后未持久化 | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/59563.md) | complete | Apr 25, 2026, 17:52 UTC |
| [#59534](https://github.com/openclaw/openclaw/issues/59534) | [Bug]:  多龙虾协作的时候会出现上下文记忆消失的问题 | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/59534.md) | stale_local_checkout_blocked | Apr 25, 2026, 17:52 UTC |
| [#59413](https://github.com/openclaw/openclaw/issues/59413) | Feature Request: Per-candidate retry count for model fallback (support pool-based/proxy providers) | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/59413.md) | stale_local_checkout_blocked | Apr 25, 2026, 17:52 UTC |
| [#59451](https://github.com/openclaw/openclaw/issues/59451) | [Feature]: Add file-based fallback search when `node:sqlite` is unavailable | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/59451.md) | complete | Apr 25, 2026, 17:52 UTC |
| [#59360](https://github.com/openclaw/openclaw/issues/59360) | Feishu card message footer causes agent name to appear at message start (Markdown definition list parsing) | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/59360.md) | stale_local_checkout_blocked | Apr 25, 2026, 17:52 UTC |
| [#59514](https://github.com/openclaw/openclaw/issues/59514) | feat: support Bearer token auth for Bedrock gateway proxies | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/59514.md) | stale_local_checkout_blocked | Apr 25, 2026, 17:52 UTC |
| [#59562](https://github.com/openclaw/openclaw/issues/59562) | Telegram: Agent messages lack paragraph breaks and CJK table misalignment | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/59562.md) | complete | Apr 25, 2026, 17:52 UTC |
| [#59125](https://github.com/openclaw/openclaw/issues/59125) | [Bug]: approvals.exec.mode accepts invalid value, approvals/subagents unreliable on main and channels | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/59125.md) | stale_local_checkout_blocked | Apr 25, 2026, 17:52 UTC |
| [#59215](https://github.com/openclaw/openclaw/issues/59215) | [Bug]: exec tool cannot authenticate to gateway in loopback mode | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/59215.md) | stale_local_checkout_blocked | Apr 25, 2026, 17:52 UTC |
| [#59345](https://github.com/openclaw/openclaw/issues/59345) | Control UI: subagent context badge can show historical total tokens as current context usage | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/59345.md) | stale_local_checkout_blocked | Apr 25, 2026, 17:51 UTC |
| [#59494](https://github.com/openclaw/openclaw/issues/59494) | node-extra-ca-certs: CA bundle auto-injection only triggers for nvm, misses fnm/volta/asdf and 5 other version managers | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/59494.md) | stale_local_checkout_blocked | Apr 25, 2026, 17:51 UTC |
| [#59470](https://github.com/openclaw/openclaw/issues/59470) | Bug: openclaw gateway call times out for plugin gateway methods even when the method executes successfully | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/59470.md) | stale_local_checkout_blocked | Apr 25, 2026, 17:51 UTC |
| [#59526](https://github.com/openclaw/openclaw/issues/59526) | Feature: allow account switching from /models buttons for GPT and Claude | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/59526.md) | stale_local_checkout_blocked | Apr 25, 2026, 17:51 UTC |
| [#59212](https://github.com/openclaw/openclaw/issues/59212) | Usage tab: bar chart tooltip clipped on tall bars (overflow:clip on .usage-left-card) | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/59212.md) | stale_local_checkout_blocked | Apr 25, 2026, 17:51 UTC |

## How It Works

The normal workflow is proposal-only. It runs configurable parallel shards and never comments or closes during review. `apply_existing=true` is the only workflow mode that comments or closes items.

Each review job:

1. Checks out this repo.
2. Uses a planner job that scans open items, prioritizes due activity, and hands explicit item-number batches to review shards.
3. Checks out `openclaw/openclaw` at `main`, with cached git objects for faster startup.
4. Runs Codex with `gpt-5.5`, medium reasoning, fast service tier, and a 10-minute per-item timeout inside the OpenClaw checkout.
5. Writes `items/<number>.md` with the decision, proposed close comment, and a GitHub snapshot hash.
6. Marks high-confidence allowed close decisions as `proposed_close`.

Codex runs without GitHub write tokens. The runner checks the OpenClaw checkout before every review, makes the checkout read-only in CI, checks it again after review, and fails the item if Codex leaves any tracked or untracked change behind.

Parallel workflow shards only receive planned item numbers. The planner posts a best-effort workflow status note to this README before shards start, each shard emits `[review]` progress lines, and the final job merges artifacts and updates the dashboard. Review jobs time out after 75 minutes so one stuck shard cannot hold the review concurrency group indefinitely. If the planner filled the current worker capacity, the publish job dispatches the next proposal-only sweep automatically. Review cadence is daily for items with activity since the last stored snapshot, all PRs, and issues younger than 30 days. Older inactive issues are reviewed weekly. When more items are due than fit in a run, the planner prioritizes active items first, then PRs, then new issues, then older weekly reviews. The dashboard reports local cadence coverage for daily PRs, daily new issues, and weekly older issues; activity-based promotion is applied by the planner while scanning GitHub snapshots.

To close later without rerunning Codex, dispatch the workflow with `apply_existing=true`. That mode reads existing `items/*.md`, refetches the issue/PR context, recomputes the snapshot hash, and only comments/closes if nothing changed since the proposal was written. Successfully closed or already-closed items move to `closed/<number>.md`; `items/` stays focused on open items that still need tracking. Folder reconciliation also compares tracked files with the current GitHub open set: externally closed items move from `items/` to `closed/`, and reopened archived items move back to `items/` as stale so the planner reviews them again. Apply runs update the dashboard when each checkpoint commits, cap total processed items separately from fresh closes, leave enough scan room to skip changed or already-closed records while still reaching fresh closures, and emit `[apply]` progress lines during long close batches. Apply mode also posts best-effort start/checkpoint/finish notes to the dashboard. When GitHub secondary throttling triggers a long retry sleep, apply mode posts a best-effort throttle heartbeat to the dashboard with the checkpoint, processed count, and next retry delay. Apply mode defaults to `apply_min_age_days=0`, `apply_kind=issue`, a 5-second close delay, 50 fresh closes per checkpoint commit, and long retry backoff for GitHub secondary write throttling, so issue cleanup can apply high-confidence closes regardless of age while PRs remain excluded. If an apply run reaches its requested close limit, it queues another apply run with the same settings.

Maintainer-authored items are never auto-closed. Candidate planning and apply mode both read GitHub's `author_association` field and exclude `OWNER`, `MEMBER`, and `COLLABORATOR` items from automated close actions.

`npm run audit` compares live open GitHub items with the generated `items/` and `closed/` records without moving files. It reports missing open records, open records still archived under `closed/`, stale `items/` records that no longer appear open, duplicate markdown records, protected-label proposed closes, and stale review-status records. Use `--output audit-report.json` for the full report, `--sample-limit N` to control console samples, and `--strict` to exit non-zero when state drift is present.

## Local Run

Requires Node 24.

```bash
source ~/.profile
npm install
npm run build
npm run plan -- --batch-size 5 --shard-count 40 --max-pages 250 --codex-model gpt-5.5 --codex-reasoning-effort medium --codex-service-tier fast
npm run review -- --openclaw-dir ../openclaw --batch-size 5 --max-pages 250 --artifact-dir artifacts/reviews --codex-model gpt-5.5 --codex-reasoning-effort medium --codex-service-tier fast --codex-timeout-ms 600000
npm run apply-artifacts -- --artifact-dir artifacts/reviews
npm run audit -- --max-pages 250 --sample-limit 25
npm run reconcile -- --dry-run
```

Apply unchanged proposals later:

```bash
source ~/.profile
npm run apply-decisions -- --limit 20
```

Manual review runs are proposal-only even if `--apply-closures` or workflow input `apply_closures=true` is set. Use `apply_existing=true` to apply unchanged proposals later.

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
