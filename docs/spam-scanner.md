# Spam Scanner

Read when changing ClawSweeper comment spam detection, audit records, or org
blocking policy.

The spam scanner is an audit-only intake lane. It watches new GitHub comments,
applies cheap deterministic filters, sends likely candidates to `gpt-4o-mini`,
and writes durable audit records. It does not block users, hide comments, label
items, reply, or mutate target repositories.

This lane is deliberately separate from the weekly issue/PR review cadence.
Spam cost scales with new comments, not with the total open issue count.

Default behavior:

- target repo: `openclaw/openclaw`
- model: `gpt-4o-mini`
- schedule: hourly cron at minute 17
- catch-up window: 3 hours
- cap: 100 prioritized comments, selected from a bounded recent over-fetch
- dedupe: comment kind, id, and `updated_at`
- action: `none`

The first live audit-only run on 2026-05-11 scanned 50 recent comments, found no
model candidates, and published `results/spam-scanner-latest.json`.

## Workflow

The workflow is `.github/workflows/spam-scanner.yml`.

Inputs:

- `target_repo`: repository to scan
- `lookback_minutes`: fallback window for scheduled/manual catch-up
- `since`: optional explicit ISO lower bound
- `max_comments`: cap for prioritized scanned comments
- `comment_ids`: exact issue comment replay
- `review_comment_ids`: exact PR review comment replay
- `model`: cheap scanner model, default `gpt-4o-mini`
- `force_reprocess`: ignore the processed-version ledger for replay

The workflow checks out the live ClawSweeper repo plus hydrated generated state,
creates a target-read GitHub App token, runs `pnpm run repair:spam-scan`, and
publishes the resulting files through `repair:publish-main`.

The current scheduled workflow is active, but GitHub cron delivery can lag or
drop a newly added workflow's first tick. Manual dispatch is the immediate
verification path.

## Comment Sources

The scanner reads recent comments newest-first and over-fetches a bounded
window before applying the `max_comments` cap. Broad scans prioritize
deterministic spam-shaped candidates first, then fill the rest of the scan
sample with normal recent comments so stale audit cleanup still runs.

The scanner reads:

- issue and PR conversation comments from
  `repos/<repo>/issues/comments?since=...`
- PR review/diff comments from `repos/<repo>/pulls/comments?since=...`
- exact issue comments from `repos/<repo>/issues/comments/<id>`
- exact review comments from `repos/<repo>/pulls/comments/<id>`

It also hydrates GraphQL minimization metadata for scanned comment node ids. If
GitHub has already minimized a comment as spam or abuse, that becomes a
deterministic signal.

Protected authors are skipped before model spend:

- `OWNER`
- `MEMBER`
- `COLLABORATOR`
- GitHub bot accounts
- configured trusted bots

Outputs in `openclaw/clawsweeper-state`:

- `results/spam-scanner-latest.json`: latest run summary
- `results/spam-scanner.json`: durable processed comment-version ledger
- `results/spam-audit/<repo-slug>/<kind>-<comment-id>.json`: per-comment audit

Audit records include the comment URL, author association, body hash, short body
excerpt, deterministic signals, model, model result, and `action: none`.
When a reprocessed comment no longer qualifies as a candidate, its stale
per-comment audit file is removed from generated state.

## Detection

Deterministic signals are intentionally simple and cheap:

- GitHub minimized reason contains `spam` or `abuse`
- known URL shortener
- service-pitch wording such as web scraping, data extraction, flash sale, or
  sample work
- priced short service pitch

GitHub, raw GitHub content, and localhost links are treated as project context,
not spam links. Maintainer, collaborator, member, contributor, and trusted bot
comments are not sent to the cheap model.

Multiple non-GitHub external links and outside-author external links are
recorded as supporting signals only. They do not make a comment a model
candidate unless a stronger spam-shaped signal is also present.

Only comments with deterministic signals are sent to `gpt-4o-mini`. The model
returns strict JSON:

- `spam_signal`: `none`, `low`, `medium`, or `high`
- `confidence`: 0-1
- `reasons`: short strings
- `should_investigate`: scheduler hint only

The model result is not an enforcement decision. In audit-only mode it only
decides whether an audit record is worth writing and whether a later Codex
investigation lane should prioritize the comment.

If the configured model is missing or the model call fails, the workflow still
publishes deterministic audit records with `model_error` instead of failing the
spam lane. Model failures must not block monitoring.

## Safety

Current safety properties:

- no org block endpoint is called
- no comment hiding/deletion endpoint is called
- no target labels or replies are written
- full comment bodies are not required in durable state; records store a body
  hash plus a short excerpt
- processed comment versions are deduped, so edits are reviewed but unchanged
  comments are not reprocessed forever

Future blocking must be a separate apply step. It needs explicit org permission
`Blocking users: write`, maintainer/collaborator allowlisting, and audit records
that prove the exact comment and reason for each block.

## Operations

Run manually:

```bash
pnpm run build:repair
OPENAI_API_KEY=... pnpm run repair:spam-scan -- \
  --write-report \
  --repo openclaw/openclaw \
  --lookback-minutes 180 \
  --max-comments 100
```

Use exact comment ids for event replays:

```bash
pnpm run repair:spam-scan -- --write-report --repo openclaw/openclaw --comment-ids 123
pnpm run repair:spam-scan -- --write-report --repo openclaw/openclaw --review-comment-ids 456
```

Inspect latest generated state:

```bash
git -C ../clawsweeper-state fetch origin state
git -C ../clawsweeper-state show origin/state:results/spam-scanner-latest.json
git -C ../clawsweeper-state ls-tree -r --name-only origin/state results/spam-audit
```

Manual workflow dispatch:

```bash
gh workflow run spam-scanner.yml \
  --repo openclaw/clawsweeper \
  --ref main \
  -f target_repo=openclaw/openclaw \
  -f lookback_minutes=180 \
  -f max_comments=100 \
  -f model=gpt-4o-mini \
  -f force_reprocess=false
```
