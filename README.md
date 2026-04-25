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

Last dashboard update: Apr 25, 2026, 11:07 UTC

<!-- clawsweeper-status:start -->
### Workflow Status

Updated: Apr 25, 2026, 11:07 UTC

State: Apply in progress

Checkpoint 8 finished. Fresh closes in checkpoint: 50. Total fresh closes in this run: 400/500. Result records in checkpoint: 51.
Run: [https://github.com/openclaw/clawsweeper/actions/runs/24928065717](https://github.com/openclaw/clawsweeper/actions/runs/24928065717)
<!-- clawsweeper-status:end -->

| Metric | Count |
| --- | ---: |
| Open issues in [openclaw/openclaw](https://github.com/openclaw/openclaw) | 8374 |
| Fresh reviewed issues in the last 7 days | 8365 |
| Proposed issue closes | 2777 (33.2% of reviewed issues) |
| Open PRs in [openclaw/openclaw](https://github.com/openclaw/openclaw) | 5044 |
| Fresh reviewed PRs in the last 7 days | 4984 |
| Proposed PR closes | 568 (11.4% of reviewed PRs) |
| Open items total | 13418 |
| Reviewed files | 13349 |
| Unreviewed open items | 69 |
| Archived closed files | 5766 |
| Fresh verified reviews in the last 7 days | 13349 |
| Proposed closes awaiting apply | 3345 (25.1% of fresh reviews) |
| Closed by Codex apply | 4007 |
| Failed or stale reviews | 0 |
| Daily cadence coverage | 10490/10577 current (87 due, 99.2%) |
| Daily PR cadence | 4897/4984 current (87 due, 98.3%) |
| Daily new issue cadence (<30d) | 5593/5593 current (0 due, 100%) |
| Weekly older issue cadence | 2772/2772 current (0 due, 100%) |
| Due now by cadence | 156 |

Recently reviewed:

| Item | Title | Outcome | Status | Reviewed |
| --- | --- | --- | --- | --- |
| [#71527](https://github.com/openclaw/openclaw/issues/71527) | How to register Claude Max OAuth token (sk-ant-oat01-) in OpenClaw 2026.4.15 — gateway rejects 'token' key in openclaw.json auth.profiles | [close / proposed_close](https://github.com/openclaw/clawsweeper/blob/main/items/71527.md) | complete | Apr 25, 2026, 10:56 UTC |
| [#71529](https://github.com/openclaw/openclaw/issues/71529) | [Bug]: Unhandled EHOSTUNREACH in SSRF/Telegram module causes Gateway crash | [close / proposed_close](https://github.com/openclaw/clawsweeper/blob/main/items/71529.md) | complete | Apr 25, 2026, 10:56 UTC |
| [#71540](https://github.com/openclaw/openclaw/issues/71540) | Config Auto-Restore Conflict — plugins.allow Phantom Entries Bug | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/71540.md) | complete | Apr 25, 2026, 10:56 UTC |
| [#71522](https://github.com/openclaw/openclaw/issues/71522) | [Bug]: memory index --force consistently fails with `fetch failed` while direct node fetch to OpenRouter /v1/embeddings succeeds (Linux, 2026.4.21 & 2026.4.23) | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/71522.md) | complete | Apr 25, 2026, 10:56 UTC |
| [#71536](https://github.com/openclaw/openclaw/issues/71536) | [Bug]: Issue Report: Telegram restart Command Authorization Failure | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/71536.md) | complete | Apr 25, 2026, 10:55 UTC |
| [#71525](https://github.com/openclaw/openclaw/issues/71525) | Telegram channel: messages truncated mid-word when default \"partial\" streaming finaliser doesn't fire | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/71525.md) | complete | Apr 25, 2026, 10:55 UTC |
| [#71532](https://github.com/openclaw/openclaw/issues/71532) | WebChat: Drag-and-drop file upload not received by agent | [close / proposed_close](https://github.com/openclaw/clawsweeper/blob/main/items/71532.md) | complete | Apr 25, 2026, 10:55 UTC |
| [#66368](https://github.com/openclaw/openclaw/issues/66368) | CLI commands hang on first invocation (qclaw-plugin synchronous initialization blocks Gateway) | [close / proposed_close](https://github.com/openclaw/clawsweeper/blob/main/items/66368.md) | complete | Apr 25, 2026, 10:55 UTC |
| [#71526](https://github.com/openclaw/openclaw/issues/71526) | [Bug]: Azure gpt-image-2 deployment works in SDK/UI but OpenClaw image_generate returns model does not exist | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/71526.md) | complete | Apr 25, 2026, 10:55 UTC |
| [#71531](https://github.com/openclaw/openclaw/issues/71531) | RFE: expose Slack channel log level via openclaw.json (e.g., channels.slack.logLevel) so operators can suppress designed-and-benign socket-mode noise | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/71531.md) | complete | Apr 25, 2026, 10:55 UTC |
| [#65428](https://github.com/openclaw/openclaw/issues/65428) | [Bug]: resolveCliAuthEpoch() in cli-runner-DYmrT_Nx.js hashes accessToken + refreshToken + expiresAt from ~/.claude/.credentials.json | [close / proposed_close](https://github.com/openclaw/clawsweeper/blob/main/items/65428.md) | complete | Apr 25, 2026, 10:55 UTC |
| [#71533](https://github.com/openclaw/openclaw/issues/71533) | RFE: expose WhatsApp/Baileys channel log level via openclaw.json (e.g., channels.whatsapp.logLevel) to suppress designed-and-benign reconnect lifecycle logs | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/71533.md) | complete | Apr 25, 2026, 10:55 UTC |
| [#71521](https://github.com/openclaw/openclaw/issues/71521) | [Bug]: Regression of #70193 in 2026.4.23 — bundled-deps installer places playwright-core where dist pw-ai loader can't resolve it, Chromium binary also not fetched | [close / proposed_close](https://github.com/openclaw/clawsweeper/blob/main/items/71521.md) | complete | Apr 25, 2026, 10:54 UTC |
| [#71538](https://github.com/openclaw/openclaw/issues/71538) | github-copilot: gpt-5.5 and gemini-3.1-pro fail with 'missing Editor-Version header for IDE auth' | [close / proposed_close](https://github.com/openclaw/clawsweeper/blob/main/items/71538.md) | complete | Apr 25, 2026, 10:54 UTC |
| [#69298](https://github.com/openclaw/openclaw/issues/69298) | [Bug]: Codex harness usage inflates session context accounting by double-counting cached input | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/69298.md) | complete | Apr 25, 2026, 10:54 UTC |
| [#49366](https://github.com/openclaw/openclaw/pull/49366) | fix(gateway): avoid persisting service env secrets [AI-assisted] | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/49366.md) | complete | Apr 25, 2026, 10:54 UTC |
| [#49394](https://github.com/openclaw/openclaw/pull/49394) | feat: improve Chinese model reliability and add AIsa provider plugin | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/49394.md) | complete | Apr 25, 2026, 10:54 UTC |
| [#64585](https://github.com/openclaw/openclaw/issues/64585) | Auto-recover stuck gateway sessions after restart | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/64585.md) | complete | Apr 25, 2026, 10:54 UTC |
| [#49198](https://github.com/openclaw/openclaw/pull/49198) | Fix/dist-runtime skill copy instead of symlink | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/49198.md) | complete | Apr 25, 2026, 10:54 UTC |
| [#49333](https://github.com/openclaw/openclaw/pull/49333) | Add OpenClaw audit and contribution planning docs | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/49333.md) | complete | Apr 25, 2026, 10:54 UTC |

## How It Works

The normal workflow is proposal-only. It runs configurable parallel shards and never comments or closes unless `apply_closures=true` is explicitly set for a manual run.

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

## Local Run

Requires Node 24.

```bash
source ~/.profile
npm install
npm run build
npm run plan -- --batch-size 5 --shard-count 40 --max-pages 250 --codex-model gpt-5.5 --codex-reasoning-effort medium --codex-service-tier fast
npm run review -- --openclaw-dir ../openclaw --batch-size 5 --max-pages 250 --artifact-dir artifacts/reviews --codex-model gpt-5.5 --codex-reasoning-effort medium --codex-service-tier fast --codex-timeout-ms 600000
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

- `OPENAI_API_KEY`: OpenAI API key used by Codex.
- `CODEX_API_KEY`: same API key for `codex exec` CI auth.
- `OPENCLAW_GH_TOKEN`: GitHub token with write access to `openclaw/openclaw` issues and PRs.

The workflow logs Codex in with `OPENAI_API_KEY`, passes `CODEX_API_KEY` to `codex exec`, and fails the shard instead of writing fallback review markdown if Codex auth/output fails. It uses `OPENCLAW_GH_TOKEN` for `openclaw/openclaw` comments/closes. The built-in `GITHUB_TOKEN` commits review markdown back to this repo.
