---
name: local-clawsweeper-review
description: Run local ClawSweeper exact-item or committed-range reviews without GitHub mutation.
---

# Local ClawSweeper Review

Use this skill when someone wants read-only local ClawSweeper output before
submitting, updating, or re-reviewing an issue or PR.

## Safety Boundary

- Run only `pnpm run review -- --local-only` for an existing GitHub item, or
  `pnpm run review -- --local-range` for a pre-submission committed range.
- Do not run `apply-artifacts`, `apply-decisions`, GitHub comment posting, or
  merge/autofix commands unless the user explicitly asks for that mutation.
- Do not print `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, GitHub
  tokens, or Codex auth material.
- Treat generated review artifacts as local proof. Do not claim ClawSweeper
  posted or synced anything unless a separate explicit mutation command did it.

## Locate ClawSweeper

Prefer the current repository when its `package.json` name is
`@openclaw/clawsweeper`. Otherwise use a known clean local checkout:

- Windows: `C:\oc-work\clawsweeper-source`
- POSIX fallback: `~/Projects/clawsweeper`

Inspect `git status --short` before making changes. If another ClawSweeper clone
is dirty or ambiguous, do not use it for the local review runner.

## First-Time Setup

From the ClawSweeper checkout:

```sh
corepack enable
pnpm install
pnpm run build:all
pnpm run codex:local:check
```

If the Codex check says the CLI is not logged in, have the operator authenticate
their own Codex CLI. Device auth is the simplest shareable setup:

```sh
codex login --device-auth -c 'service_tier="fast"'
```

For API-key setup, pass the key through the shell only for the login command and
then clear it from the environment. Do not put the key in docs, scripts, shell
history, or committed files.

PowerShell:

```powershell
$env:OPENAI_API_KEY = Read-Host "OpenAI API key"
$env:OPENAI_API_KEY | codex login --with-api-key -c 'service_tier="fast"'
Remove-Item Env:OPENAI_API_KEY
```

POSIX shell:

```sh
printf '%s' "$OPENAI_API_KEY" | codex login --with-api-key -c 'service_tier="fast"'
unset OPENAI_API_KEY
```

If the wrong Codex binary is used, set `CODEX_BIN` in the local shell for that
run. On Windows, the runner prefers the Codex app binary under
`%LOCALAPPDATA%\OpenAI\Codex\bin\codex.exe` when `--local-only` is used.

## Target Checkout Modes

By default, an exact local PR review manages its own target checkout under
`artifacts/local-review-<pr-number>/target`.

By default, `--local-range` reviews the clean checkout where the command was
invoked. It does not manage or switch that checkout. Pass `--target-dir` when
the branch to review is elsewhere.

Pass `--target-dir` when the operator wants to review an existing checkout or
an issue.

Use a clean target checkout of the repository being reviewed. Prefer a dedicated
review checkout if the normal worktree is dirty:

- Windows: `C:\oc-work\clawsweeper-local-target-openclaw`
- POSIX fallback: `../openclaw`

Before reviewing against `main`, update the target checkout only when it is
clean:

```sh
git -C <target-dir> status --short
git -C <target-dir> fetch origin main
git -C <target-dir> switch main
git -C <target-dir> pull --ff-only origin main
```

Do not switch branches, pull, or overwrite files in a dirty target checkout.

## Run A Local Review

Use the exact issue or PR number. If the number is not provided and the current
branch has an open PR, use `gh pr view --json number,url,headRefOid` to identify
it.

From the ClawSweeper checkout:

```sh
pnpm run review -- --local-only --item-number <pr-number>
```

To use a supplied checkout or review an issue:

```sh
pnpm run review -- --local-only \
  --item-number <issue-or-pr-number> \
  --target-dir <target-dir>
```

To review committed branch work before a PR exists:

```sh
pnpm run review -- --local-range \
  --target-repo <owner/repo> \
  --base origin/main
```

The range is `merge-base(<base>, HEAD)..HEAD`. It must be clean and contain at
least one commit beyond the base. This path withholds GitHub credentials,
isolates cached `gh` auth, disables web search, and skips host-side URL/media
preprocessing. It still calls the configured Codex model service; do not call it
air-gapped or fully network-offline.

The exact local command prints a human-readable progress summary by default. Add
`--verbose` only when debugging checkout, selection, or Codex process details.

For quick smoke tests, lower `--batch-size`, `--shard-count`, `--max-pages`, and
`--codex-timeout-ms`, but label the result as a smoke run rather than a full
local review.

## Read The Artifact

The default OpenClaw report is written to:

```text
<artifact-dir>/<issue-or-pr-number>.md
```

Read the artifact and summarize:

- `review_status`
- `main_sha`
- `pull_head_sha` for PRs
- decision/confidence/action fields when present
- findings or blockers
- exact Codex/auth/runtime failure if the run failed

If the failure is Codex auth, stop after providing the local setup command. If
the failure is runner/runtime behavior, include the artifact path and a concise
stderr or log summary.

## Closeout

Before reporting success:

- Confirm the command used `review --local-only` or `review --local-range`.
- Confirm no GitHub comments, labels, merges, or apply commands were run.
- Confirm the target checkout is still clean.
- If findings exist, list the actionable items and the next local fix/test step.
- If no blockers exist, say the local ClawSweeper artifact found no blockers
  and include the reviewed `main_sha` and PR head SHA when available.
