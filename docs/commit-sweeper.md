# Commit Sweeper

Commit Sweeper manually reviews selected commits on a target repository's
`main` branch. It is intentionally separate from the issue/PR cleanup sweeper:
it does not close items, write comments, or try to fix code. It produces one
markdown report per commit. It can optionally publish a GitHub Check Run for the
commit when `create_checks=true`.

## Goals

- Review selected code-bearing commits on `main` for regressions, bugs, and
  security issues.
- Use one Codex worker per reviewed commit.
- Keep reports human-readable and markdown-first.
- Keep the storage path canonical so each commit has at most one report.
- Avoid spending Codex time on pure documentation, changelog, asset, or other
  non-code commits.
- Make the lane easy to disable, manually trigger, and backfill over historic
  ranges.

## Storage

Reports live at:

```text
records/<repo-slug>/commits/<40-char-sha>.md
```

That path is the source of truth. Rerunning a commit review overwrites the same
file. Manual reruns with an additional prompt also overwrite the same file.

Report front matter includes both commit timestamps and review timestamps:

- `commit_authored_at`: author timestamp from the target commit
- `commit_committed_at`: committer timestamp from the target commit
- `reviewed_at`: timestamp for the ClawSweeper report generation

Skipped non-code commits still get a report at the same path with
`result: skipped_non_code`. This preserves a complete audit trail without
starting Codex for commits that cannot affect runtime behavior.

Use the report lister for time windows instead of date-based storage folders:

```bash
pnpm run build
pnpm commit-reports -- --since 6h
pnpm commit-reports -- --since "24 hours ago" --findings
pnpm commit-reports -- --since 7d --non-clean
pnpm commit-reports -- --repo openclaw/openclaw --author steipete --since 7d
```

The canonical storage stays flat so a rerun can overwrite exactly one file for
the commit without first rediscovering a date bucket.

## Triggers

Automatic target `push` dispatch is disabled in production. The receiver
workflow is `.github/workflows/commit-review.yml` and currently runs from manual
`workflow_dispatch` only.

Manual workflow dispatch supports:

- `target_repo`: repository to inspect
- `commit_sha`: commit SHA to review, or end of a historic range
- `before_sha`: optional range start; when present, review every commit in
  `before_sha..commit_sha`
- `additional_prompt`: appended to the Codex prompt for this run
- `create_checks`: create/update GitHub Checks. Leave blank to use the receiver
  repo variable fallback; otherwise pass `true` or `false`. The effective
  default is `false`.
- `enabled`: emergency no-op switch
- `commit_offset`: internal continuation offset

The receiver waits 60 seconds by default before selecting commits. This gives
the target `main` push event time to settle across GitHub and the runner without
holding the planner for a full review cycle. Override it on
`openclaw/clawsweeper` with:

```text
CLAWSWEEPER_COMMIT_REVIEW_SETTLE_SECONDS=60
```

Use `0` for manual backfills where the target commit range is already settled,
or temporarily raise the value during GitHub event lag incidents.

The receiver enforces that the commit is reachable from `origin/main`. Review
workers then check out current target `main` and reference the reviewed commit
by SHA/range rather than detaching the whole target repository at the commit.

## Scaling

Commit Sweeper is background work. It defaults to 6 commits per workflow page
when the system is quiet, but the receiver asks the central worker scheduler for
the effective page size before dispatching the matrix. Active repair,
exact-item review, and sweep work can lower commit review to keep capacity
available for maintainer-visible work. The checked-in default lives in
`config/automation-limits.json`. The receiver clamps
`CLAWSWEEPER_COMMIT_REVIEW_PAGE_SIZE` between 1 and 128, then pages large ranges:

- select up to the configured page size
- classify them cheaply
- start one matrix worker per code-bearing commit
- write skipped reports for non-code commits
- commit all reports
- dispatch the next page with `workflow_dispatch` when more commits remain

A 200-commit manual range runs as multiple continuation runs at the effective
page size. Leave `CLAWSWEEPER_COMMIT_REVIEW_PAGE_SIZE` unset to use dynamic
scheduling. Raise the page size only when the org has enough rate-limit
headroom.

## Cheap Classification

The plan job classifies each selected commit before creating the Codex matrix.
It uses `git diff --name-only` for normal commits and `git diff-tree` for root
commits.

Codex runs when any changed path looks reviewable:

- source files
- tests
- scripts and `bin/`
- GitHub workflows
- package manifests
- lockfiles
- build/runtime/config files

Codex is skipped when all changed paths are non-code:

- docs directories
- changelog-only changes
- README/license/notice-style files
- markdown/text documentation
- common image/video/PDF assets

Mixed commits are reviewed. A commit that changes both docs and code gets a
Codex worker.

## Codex Review

The prompt lives in `prompts/review-commit.md`.

Codex reviews the provided commit range and is expected to read beyond the diff:

- changed files in full
- callers/callees
- configuration and runtime entry points
- adjacent tests and docs when they define contracts
- dependency manifests and lockfiles when relevant
- package health, release notes, install scripts, and advisories when relevant
- general web sources when current external facts matter
- focused live tests or smoke checks when feasible

The time budget is 30 minutes per commit.

Codex returns markdown only. The front matter is small and stable so tooling can
index results and optionally publish checks, but the body is meant for
maintainers to read.

## Report Results

Expected `result` values:

- `nothing_found`: high-confidence clean review
- `findings`: concrete potential bug, regression, or security issue
- `inconclusive`: insufficient confidence or blocked verification
- `failed`: Codex/tooling failed before a reliable report
- `skipped_non_code`: cheap classifier skipped a non-code-only commit

Issue categories Codex looks for:

- bug
- regression
- security
- supply-chain
- data loss
- privacy
- reliability
- concurrency
- compatibility
- concrete test gaps that hide a plausible bug

The prompt explicitly excludes style nits, broad refactor taste, generic
cleanliness feedback, speculative security concerns without an executable path,
and test coverage complaints without a concrete risk.

## ClawSweeper Repair Dispatch

After reports are committed, `.github/workflows/commit-review.yml` can dispatch
actionable `result: findings` reports to this repo's
`repair-commit-finding-intake.yml` workflow. The older
`repository_dispatch` mode is still available in the CLI for tests or future
App-permission changes, but the workflow uses `workflow_dispatch` so the
ClawSweeper App only needs Actions write access on `openclaw/clawsweeper`.

The dispatch is intentionally report-based. ClawSweeper sends the target repo,
commit SHA, report repo, report path, report URL, severity, check conclusion,
and source run URL. The repair intake fetches the report from latest
`openclaw/clawsweeper@main`, writes an audit record, and decides whether an
automatic PR makes sense on latest target `main`.

Disable this without code changes by setting:

```text
CLAWSWEEPER_COMMIT_FINDINGS_ENABLED=false
```

The ClawSweeper repair lane owns the PR lifecycle, validation, branch reuse, and
no-merge gate. Security-sensitive findings should remain audit-only.

## Optional GitHub Checks

The check name is:

```text
ClawSweeper Commit Review
```

Check conclusions:

- `success`: high-confidence clean report or skipped non-code commit
- `failure`: high-confidence high/critical finding
- `neutral`: lower-severity finding, inconclusive review, or failed review
- `timed_out`: Codex timed out

Checks are created on the target repository commit by the ClawSweeper GitHub
App. They behave like CI in GitHub's UI, but are separate from the target
repository's normal test workflows.

Checks are disabled by default to avoid spending GitHub App installation rate
limit on status publishing. Enable them per run with `create_checks=true`, by
sending `create_checks:true` in the dispatch payload, or by setting this
variable in the target repository that runs the dispatch workflow:

```text
CLAWSWEEPER_COMMIT_REVIEW_CREATE_CHECKS=true
```

The receiver also honors the same variable on `openclaw/clawsweeper` when a
manual or repository dispatch omits `create_checks`.

Commit Sweeper does not post comments. Markdown reports are the primary public
surface; checks are an optional secondary surface.

## Safety

The review worker receives only target read credentials while Codex runs. The
Codex subprocess gets that read token as `GH_TOKEN` so it can hydrate mentioned
issues, PRs, workflow runs, and commit metadata during review.
Write/check credentials are created only after Codex exits.

The Codex environment strips GitHub and app secrets before subprocess launch.

The scheduled/hosted Commit Sweeper lane is main-only — automated PR or branch
review on the server is deliberately out of scope.

## Local branch review (`local-review`)

For a manual, offline pre-PR self-review, the `local-review` subcommand reuses the
same Commit Sweeper engine against the current branch's committed range:

```text
pnpm run build
pnpm local-review -- --base main
# reviews merge-base(<base>, HEAD)..HEAD as one unit
# writes ~/.clawsweeper-local-reviews/run-<sha>-<ts>-<pid>/local-review.md
```

It is offline by contract and never contacts GitHub: it requires a clean checkout,
uses a unique per-run output directory, withholds all GitHub token env vars, skips
the `gh`-api commit-metadata hydration, points `GH_CONFIG_DIR` at an empty directory,
disables Codex web search, and explicitly forbids network lookups. Repositories
without a configured profile are rejected (no foreign-profile fallback). Unlike the
hosted lane it never writes to GitHub — the local Markdown report is the only output.

## Enable / Disable

Target repositories can disable hook-based dispatch with:

```text
CLAWSWEEPER_COMMIT_REVIEW_ENABLED=false
```

Manual dispatch can also set `enabled=false`.

Checks are disabled by default. Enable or disable them without changing code via:

- manual dispatch input `create_checks=true|false`
- repository dispatch payload `create_checks:true|false`
- target repo variable `CLAWSWEEPER_COMMIT_REVIEW_CREATE_CHECKS=true|false`

Reports are always written either way.

## Related Files

- `.github/workflows/commit-review.yml`: receiver workflow
- `docs/commit-dispatcher.md`: target repository dispatch template
- `src/commit-sweeper.ts`: commit review CLI
- `src/commit-classifier.ts`: cheap path classifier and skipped reports
- `src/commit-checks.ts`: GitHub Check Run publishing
- `prompts/review-commit.md`: Codex review prompt
