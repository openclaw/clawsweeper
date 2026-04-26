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

Last dashboard update: Apr 26, 2026, 07:09 UTC

### Current Run

<!-- clawsweeper-status:start -->
**Workflow status**

Updated: Apr 26, 2026, 07:09 UTC

State: Apply in progress

Starting apply/comment-sync run for up to 20 fresh all closes. Existing Codex automated review comments are updated in place; checkpoints commit every 50 fresh closes; close delay is 2000ms; sync-comments-only=false; item numbers=all.
Run: [https://github.com/openclaw/clawsweeper/actions/runs/24950824726](https://github.com/openclaw/clawsweeper/actions/runs/24950824726)
<!-- clawsweeper-status:end -->

### Queue

| Metric | Count |
| --- | ---: |
| Open issues in [openclaw/openclaw](https://github.com/openclaw/openclaw) | 4182 |
| Open PRs in [openclaw/openclaw](https://github.com/openclaw/openclaw) | 3849 |
| Open items total | 8031 |
| Reviewed files | 7817 |
| Unreviewed open items | 214 |
| Archived closed files | 11480 |

### Review Outcomes

| Metric | Count |
| --- | ---: |
| Fresh reviewed issues in the last 7 days | 4075 |
| Proposed issue closes | 61 (1.5% of reviewed issues) |
| Fresh reviewed PRs in the last 7 days | 3693 |
| Proposed PR closes | 26 (0.7% of reviewed PRs) |
| Fresh verified reviews in the last 7 days | 7768 |
| Proposed closes awaiting apply | 87 (1.1% of fresh reviews) |
| Closed by Codex apply | 8986 |
| Failed or stale reviews | 49 |

### Cadence

| Metric | Coverage |
| --- | ---: |
| Hourly cadence coverage | 277/883 current (606 due, 31.4%) |
| Hourly hot item cadence (<7d) | 277/883 current (606 due, 31.4%) |
| Daily cadence coverage | 4843/4945 current (102 due, 97.9%) |
| Daily PR cadence | 3235/3318 current (83 due, 97.5%) |
| Daily new issue cadence (<30d) | 1608/1627 current (19 due, 98.8%) |
| Weekly older issue cadence | 1984/1989 current (5 due, 99.7%) |
| Due now by cadence | 927 |

### Audit Health

<!-- clawsweeper-audit:start -->
Last audit: Apr 26, 2026, 06:52 UTC

Status: **Action needed**

| Metric | Count |
| --- | ---: |
| Scan complete | yes |
| Open items seen | 8155 |
| Missing eligible open records | 5 |
| Missing maintainer-authored open records | 72 |
| Missing protected open records | 0 |
| Missing recently-created open records | 142 |
| Archived records that are open again | 0 |
| Stale item records | 7 |
| Duplicate records | 0 |
| Protected proposed closes | 2 |
| Stale reviews | 41 |

| Item | Category | Title | Detail |
| --- | --- | --- | --- |
| [#66922](https://github.com/openclaw/openclaw/issues/66922) | Missing eligible open | [Bug]: xAI grok reasoning models (grok-4-1-fast-reasoning) ignore workspace IDENTITY.md behavioral rules at 0% compliance rate | eligible |
| [#66923](https://github.com/openclaw/openclaw/issues/66923) | Missing eligible open | OpenClaw Model Registry: GPT-4.1 family passes through unmanaged | eligible |
| [#68655](https://github.com/openclaw/openclaw/issues/68655) | Missing eligible open | bug(web-ui): streaming markdown flickers — full DOM replacement on every token via unsafeHTML | eligible |
<!-- clawsweeper-audit:end -->

### Latest Run Activity

Latest review: Apr 26, 2026, 07:00 UTC. Latest close: Apr 26, 2026, 07:07 UTC. Latest comment sync: Apr 26, 2026, 07:07 UTC.

| Window | Reviews | Close decisions | Keep-open decisions | Failed/stale reviews | Closed | Comments synced | Apply skips |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Last 15 minutes | 101 | 19 | 82 | 0 | 100 | 101 | 0 |
| Last hour | 788 | 181 | 607 | 3 | 295 | 269 | 1 |
| Last 24 hours | 10335 | 2358 | 7977 | 62 | 5333 | 1270 | 115 |

<details>
<summary>Recently Reviewed (latest 10)</summary>

<br>

| Item | Title | Outcome | Status | Reviewed |
| --- | --- | --- | --- | --- |
| [#48442](https://github.com/openclaw/openclaw/pull/48442) | feat: add systemPrompt.identityLine and disabledSections config | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/48442.md) | complete | Apr 26, 2026, 07:00 UTC |
| [#48285](https://github.com/openclaw/openclaw/pull/48285) | fix(gateway): allow loopback node-role sessions without device identity | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/48285.md) | complete | Apr 26, 2026, 06:58 UTC |
| [#48643](https://github.com/openclaw/openclaw/pull/48643) | feat(ui): add parallel thread creation in chat | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/48643.md) | complete | Apr 26, 2026, 06:58 UTC |
| [#55767](https://github.com/openclaw/openclaw/pull/55767) | fix(hooks): reject internal session namespaces | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/55767.md) | complete | Apr 26, 2026, 06:58 UTC |
| [#48537](https://github.com/openclaw/openclaw/pull/48537) | Telegram: avoid aborting sends on polling restart | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/48537.md) | complete | Apr 26, 2026, 06:57 UTC |
| [#48336](https://github.com/openclaw/openclaw/pull/48336) | feat(gateway): add general per-IP request rate limiter | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/48336.md) | complete | Apr 26, 2026, 06:57 UTC |
| [#48681](https://github.com/openclaw/openclaw/pull/48681) | feat(agents): support multiple workspaces via composite symlink directory | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/48681.md) | complete | Apr 26, 2026, 06:57 UTC |
| [#48668](https://github.com/openclaw/openclaw/pull/48668) | feat(memory-lancedb): Add Gemini embedding model support | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/48668.md) | complete | Apr 26, 2026, 06:57 UTC |
| [#48742](https://github.com/openclaw/openclaw/pull/48742) | fix(doctor): auto-remove legacy notify:true when cron.webhook is unset | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/48742.md) | complete | Apr 26, 2026, 06:57 UTC |
| [#48520](https://github.com/openclaw/openclaw/pull/48520) | feat(sea): package OpenClaw as Node.js Single Executable Application for container deployment | [keep_open / kept_open](https://github.com/openclaw/clawsweeper/blob/main/items/48520.md) | complete | Apr 26, 2026, 06:57 UTC |

</details>

## How It Works

ClawSweeper has two independent lanes.

### Review Lane

Review is proposal-only. It never closes items.

- A planner scans open issues and PRs, then assigns exact item numbers to shards.
- Manual runs can pass `item_number` or comma-separated `item_numbers` to review
  exact Audit Health findings without scanning for a normal batch.
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
npm run plan -- --batch-size 5 --shard-count 100 --max-pages 250 --codex-model gpt-5.5 --codex-reasoning-effort high --codex-service-tier fast
npm run review -- --openclaw-dir ../openclaw --batch-size 5 --max-pages 250 --artifact-dir artifacts/reviews --codex-model gpt-5.5 --codex-reasoning-effort high --codex-service-tier fast --codex-timeout-ms 600000
npm run apply-artifacts -- --artifact-dir artifacts/reviews
npm run audit -- --max-pages 250 --sample-limit 25 --update-dashboard
npm run reconcile -- --dry-run
```

Apply unchanged proposals later:

```bash
source ~/.profile
npm run apply-decisions -- --limit 20 --apply-kind all
```

Manual review runs are proposal-only even if `--apply-closures` or workflow input `apply_closures=true` is set. Use `apply_existing=true` to apply unchanged proposals later. Scheduled apply runs process both issues and pull requests by default; pass `apply_kind=issue` or `apply_kind=pull_request` to narrow a manual run.

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
