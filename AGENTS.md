# AGENTS.MD

ClawSweeper is the conservative maintenance bot for OpenClaw repositories.
Keep changes narrow, evidence-backed, and automation-safe.

## Structure

- Main code: `src/clawsweeper.ts`.
- Repair lane code: `src/repair/`; durable generated state lives in
  `openclaw/clawsweeper-state`.
- Tests: `test/*.test.ts` and `test/repair/*.test.ts`; add new coverage to the
  narrowest matching test file instead of growing `test/clawsweeper.test.ts`.
- Workflow: `.github/workflows/sweep.yml`.
- Explainer: `README.md`; state/dashboard repo: `../clawsweeper-state`.
- Open/reviewed records in state repo:
  `records/<repo-slug>/items/<number>.md`.
- Archived records in state repo:
  `records/<repo-slug>/closed/<number>.md`.
- Scratch/generated output: `.artifacts/`, `artifacts/`, `apply-report.json`.

Preserve one flat `items/` and `closed/` report layout per repository slug. Do
not split reports into issue/PR subtrees.

## Operating Model

- Review lane is proposal-only. It never closes GitHub items.
- Apply lane mutates GitHub by syncing the durable Codex review comment and then
  closing only unchanged, high-confidence proposals.
- Repository-specific rules live in `src/repository-profiles.ts`; ClawHub apply
  may close only PRs that are certainly implemented on `main`.
- Worker concurrency is shard-level: each shard processes its selected items
  sequentially. Maximum parallel Codex sessions equals `shard_count`, not
  `batch_size * shard_count`.
- `openclaw/clawsweeper-state` is the live status surface and generated state
  store. Check current Actions and that repo before trusting local generated
  timestamps.
- When Peter asks about PRs outside `openclaw/clawsweeper`, treat the task as
  monitoring/debugging how ClawSweeper workflows operate on that PR. Do not fix
  foreign PR branches directly; ClawSweeper repair/automerge workflows own those
  branch edits.
- OpenClaw `CHANGELOG.md` is release-owned. Do not ask contributor PR authors,
  repair workers, or automerge/autofix lanes to edit it during normal PR work.
  Preserve release-note context in PR bodies and commit messages instead.
- When referencing GitHub issues or PRs in user-facing output, always include
  the full GitHub URL, not only `#12345`.

## Safety Rules

- Do not run live apply/close commands unless Peter explicitly asks.
- For apply-path repros, copy one report into a temp `items/` dir and pass
  `--skip-dashboard`, `--item-number`, and a temp `--closed-dir`.
- Treat maintainer-authored and protected-label items as non-closeable.
- Snapshot or `updated_at` drift blocks apply unless the only change is the
  existing ClawSweeper review comment.
- Open-but-locked issues can exist when stale automation locked a closed issue
  and the author later reopened it. These must be skipped, not allowed to crash
  the apply run.
- Locked-comment 403s from GitHub are terminal apply skips, not retryable API
  failures.

## Commands

```bash
corepack enable
pnpm install
pnpm run build
pnpm run test:unit
pnpm run format
pnpm run check
```

Use `pnpm run check` before handoff for code/test/workflow changes.

`engines.node` is `>=24`. Node 22 will install (no `engine-strict`) but the
notifier tests' 5-second retry paths surface as `cancelledByParent` under the
old `node:test` runner. Run on Node 24 or newer before reporting test
failures.

## GitHub Checks

Useful live probes:

```bash
gh run list --repo openclaw/clawsweeper --limit 20 --json databaseId,displayTitle,status,conclusion,createdAt,updatedAt
gh api repos/openclaw/clawsweeper/readme --jq '.content' | base64 --decode
gh api graphql -f query='query { repository(owner:"openclaw", name:"openclaw") { issues(states: OPEN) { totalCount } pullRequests(states: OPEN) { totalCount } } }'
```

For throughput/default tuning, inspect and update both `src/clawsweeper.ts` and
`.github/workflows/sweep.yml`; continuation paths can otherwise keep stale
defaults.
