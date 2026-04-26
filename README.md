# ClawSweeper

ClawSweeper is the conservative OpenClaw maintenance bot for
`openclaw/openclaw`.

It keeps one markdown report per open issue or PR, publishes one durable Codex
automated review comment when useful, and only closes items when the evidence is
strong.

## Guardrails

ClawSweeper may propose a close only when the item is clearly one of these:

- implemented on current `main`
- not reproducible on current `main`
- better suited for ClawHub skill/plugin work than core
- duplicate or superseded by a canonical issue/PR
- concrete but not actionable in this source repo
- incoherent enough that no action can be taken
- stale issue older than 60 days with too little data to verify

Maintainer-authored items are never auto-closed. Everything else stays open.

## Dashboard

Last dashboard update: Apr 26, 2026, 05:43 UTC

### Current Run

<!-- clawsweeper-status:start -->
**Workflow status**

Updated: Apr 26, 2026, 05:43 UTC

State: Apply in progress

Checkpoint 1 finished. Fresh closes in checkpoint: 1. Total fresh closes in this run: 1/20. Result records in checkpoint: 400, including durable review comment syncs.
Run: [https://github.com/openclaw/clawsweeper/actions/runs/24949172948](https://github.com/openclaw/clawsweeper/actions/runs/24949172948)
<!-- clawsweeper-status:end -->

### Queue

| Metric | Count |
| --- | ---: |
| Open issues in [openclaw/openclaw](https://github.com/openclaw/openclaw) | 4230 |
| Open PRs in [openclaw/openclaw](https://github.com/openclaw/openclaw) | 4206 |
| Open items total | 8436 |
| Reviewed files | 8236 |
| Unreviewed open items | 200 |
| Archived closed files | 11061 |

### Review Outcomes

| Metric | Count |
| --- | ---: |
| Fresh reviewed issues in the last 7 days | 4142 |
| Proposed issue closes | 7 (0.2% of reviewed issues) |
| Fresh reviewed PRs in the last 7 days | 4069 |
| Proposed PR closes | 284 (7% of reviewed PRs) |
| Fresh verified reviews in the last 7 days | 8211 |
| Proposed closes awaiting apply | 291 (3.5% of fresh reviews) |
| Closed by Codex apply | 8659 |
| Failed or stale reviews | 25 |

### Cadence

| Metric | Coverage |
| --- | ---: |
| Hourly cadence coverage | 254/964 current (710 due, 26.3%) |
| Hourly hot item cadence (<7d) | 254/964 current (710 due, 26.3%) |
| Daily cadence coverage | 5190/5278 current (88 due, 98.3%) |
| Daily PR cadence | 3560/3634 current (74 due, 98%) |
| Daily new issue cadence (<30d) | 1630/1644 current (14 due, 99.1%) |
| Weekly older issue cadence | 1992/1994 current (2 due, 99.9%) |
| Due now by cadence | 1000 |

### Audit Health

<!-- clawsweeper-audit:start -->
No audit has been published yet. Run `npm run audit -- --update-dashboard` to refresh this section.
<!-- clawsweeper-audit:end -->

### Latest Run Activity

Latest review: Apr 26, 2026, 05:41 UTC. Latest close: Apr 26, 2026, 05:28 UTC. Latest comment sync: Apr 26, 2026, 05:43 UTC.

| Window | Reviews | Close decisions | Keep-open decisions | Failed/stale reviews | Closed | Comments synced | Apply skips |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Last 15 minutes | 270 | 65 | 205 | 1 | 0 | 319 | 13 |
| Last hour | 1018 | 137 | 881 | 2 | 258 | 617 | 13 |
| Last 24 hours | 10572 | 2346 | 8226 | 38 | 5458 | 1305 | 184 |

<details>
<summary>Recently Reviewed (latest 10)</summary>

<br>

| Item | Title | Outcome | Status | Reviewed |
| --- | --- | --- | --- | --- |
| [#43874](https://github.com/openclaw/openclaw/pull/43874) | feat(feishu): fix board tool SDK paths and add create_whiteboard action | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/43874.md) | complete | Apr 26, 2026, 05:41 UTC |
| [#69350](https://github.com/openclaw/openclaw/issues/69350) | [Bug]: OpenRouter API key is configured and validated (works with curl), but OpenClaw returns empty responses when using openrouter/google/gemma-4-26b-a4b-it | [close / proposed_close](https://github.com/openclaw/clawsweeper/blob/main/items/69350.md) | complete | Apr 26, 2026, 05:41 UTC |
| [#69401](https://github.com/openclaw/openclaw/issues/69401) | Feature Request: Untrusted content wrapping for inbound channel messages | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/69401.md) | complete | Apr 26, 2026, 05:41 UTC |
| [#69408](https://github.com/openclaw/openclaw/issues/69408) | [agents/loop-detection]: downgrade Loop warning log level to info for isolated sessions with lifetime <= cron interval | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/69408.md) | complete | Apr 26, 2026, 05:41 UTC |
| [#43790](https://github.com/openclaw/openclaw/pull/43790) | [AI-assisted] fix(message): honor explicit agent routing | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/43790.md) | complete | Apr 26, 2026, 05:40 UTC |
| [#43565](https://github.com/openclaw/openclaw/pull/43565) | feat(tools): add allowedRoots config for fs tools | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/43565.md) | complete | Apr 26, 2026, 05:40 UTC |
| [#69331](https://github.com/openclaw/openclaw/issues/69331) | [Feature]: Add Venice.ai as an image_generate tool provider | [close / proposed_close](https://github.com/openclaw/clawsweeper/blob/main/items/69331.md) | complete | Apr 26, 2026, 05:40 UTC |
| [#69424](https://github.com/openclaw/openclaw/issues/69424) | docs-search skill broken after 2026.4.15: local docs bundle reduced from 375 files to 13 templates | [close / proposed_close](https://github.com/openclaw/clawsweeper/blob/main/items/69424.md) | complete | Apr 26, 2026, 05:40 UTC |
| [#69447](https://github.com/openclaw/openclaw/issues/69447) | Web UI attachments are image-only end-to-end (UI picker + Gateway) | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/69447.md) | complete | Apr 26, 2026, 05:40 UTC |
| [#43609](https://github.com/openclaw/openclaw/pull/43609) | fix(web-search): guard null entries in extractGrokContent, wrap Grok AbortErrors, raise Grok default timeout to 60s | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/43609.md) | complete | Apr 26, 2026, 05:40 UTC |

</details>

## How It Works

ClawSweeper has two independent lanes.

### Review Lane

Review is proposal-only. It never closes items.

- A planner scans open issues and PRs, then assigns exact item numbers to shards.
- Each shard checks out `openclaw/openclaw` at `main`.
- Codex reviews with `gpt-5.5`, high reasoning, fast service tier, and a
  10-minute per-item timeout.
- Each item becomes `items/<number>.md` with the decision, evidence, suggested
  comment, runtime metadata, and GitHub snapshot hash.
- High-confidence allowed close decisions become `proposed_close`.

Cadence:

- hourly for items with activity since the last snapshot
- hourly for anything created in the last 7 days
- daily for older PRs and issues younger than 30 days
- weekly for older inactive issues
- immediate-ish hot intake every 5 minutes for newest/active items

### Apply Lane

Apply reads existing reports and mutates GitHub only when the stored review is
still valid.

- Updates the single marker-backed Codex automated review comment in place.
- Closes only unchanged high-confidence proposals.
- Reuses the review comment when closing; no duplicate close comment.
- Moves closed or already-closed reports to `closed/<number>.md`.
- Moves reopened archived reports back to `items/<number>.md` as stale.
- Commits checkpoints and dashboard heartbeats during long runs.

Apply defaults to issue-only closes, no age floor, 2-second close delay, and
50 fresh closes per checkpoint. If it reaches the requested limit, it queues
another apply run with the same settings.

### Safety Model

- Maintainer-authored items are excluded from automated closes.
- Protected labels block close proposals.
- Codex runs without GitHub write tokens.
- CI makes the OpenClaw checkout read-only for reviews.
- Reviews fail if Codex leaves tracked or untracked changes behind.
- Snapshot changes block apply unless the only change is the bot’s own review
  comment.

### Audit

`npm run audit` compares live GitHub state with generated records without moving
files. It reports missing open records, archived open records, stale records,
duplicates, protected-label proposed closes, and stale review-status records.
Missing open records are classified as eligible, maintainer-authored, protected,
or recently created so strict audit mode can flag actionable drift without
treating expected queue lag or excluded items as failures.
Use `--update-dashboard` to publish the latest audit health into this README
without making every normal dashboard heartbeat scan all open GitHub items.
The workflow refreshes Audit Health on a separate six-hour schedule, and it can
be run manually with `audit_dashboard=true`.

## Local Run

Requires Node 24.

```bash
source ~/.profile
npm install
npm run build
npm run plan -- --batch-size 5 --shard-count 50 --max-pages 250 --codex-model gpt-5.5 --codex-reasoning-effort high --codex-service-tier fast
npm run review -- --openclaw-dir ../openclaw --batch-size 5 --max-pages 250 --artifact-dir artifacts/reviews --codex-model gpt-5.5 --codex-reasoning-effort high --codex-service-tier fast --codex-timeout-ms 600000
npm run apply-artifacts -- --artifact-dir artifacts/reviews
npm run audit -- --max-pages 250 --sample-limit 25 --update-dashboard
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
- `OPENCLAW_GH_TOKEN`: optional fallback GitHub token for read-heavy `openclaw/openclaw` scans and artifact publish reconciliation when the GitHub App token is unavailable.
- `CLAWSWEEPER_APP_ID`: GitHub App ID for `openclaw-ci`. Currently `3306130`.
- `CLAWSWEEPER_APP_PRIVATE_KEY`: private key for `openclaw-ci`; plan/review jobs use a short-lived GitHub App installation token for read-heavy `openclaw/openclaw` API calls, and apply/comment-sync jobs use the app token for comments and closes.

Token flow:

- Review shards log Codex in with `OPENAI_API_KEY`, then run without OpenAI or
  Codex token environment variables.
- ClawSweeper uses the `openclaw-ci` GitHub App token for read-heavy target
  context, falling back to `OPENCLAW_GH_TOKEN` only if app secrets are absent.
- Apply mode uses the app token for review comments and closes, so GitHub
  attributes mutations to `clawsweeper[bot]`.
- The built-in `GITHUB_TOKEN` commits generated reports back to this repo.

Required app permissions:

- read access for target scan context
- write access to `openclaw/openclaw` issues and pull requests
- optional Actions write on `openclaw/clawsweeper` for app-token-based run
  cancellation or dispatch
