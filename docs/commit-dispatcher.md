# Commit Review Dispatcher

Automatic push-triggered commit review is disabled in the production
`openclaw/clawsweeper` receiver. Maintainers can still run
`.github/workflows/commit-review.yml` manually for selected commits or ranges.

Historically, target repositories forwarded `push` events with
`repository_dispatch`; ClawSweeper expanded the pushed range into one worker per
commit, wrote one markdown report per commit, and optionally created a GitHub
Check Run on each reviewed commit when checks were enabled.

Reports are stored at:

```text
records/<repo-slug>/commits/<40-char-sha>.md
```

That path is canonical. Rerunning a commit review overwrites the existing report
for that SHA, including manual reruns with an additional prompt.

If automatic push-range review is re-enabled later, copy this workflow into each
target repository as
`.github/workflows/clawsweeper-commit-dispatch.yml`, or merge the `push` trigger
and `Dispatch commit review` step into the combined dispatcher from
[target-dispatcher.md](target-dispatcher.md). `openclaw/openclaw` uses the
combined `.github/workflows/clawsweeper-dispatch.yml` form.

```yaml
name: ClawSweeper Commit Dispatch

on:
  push:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: clawsweeper-commit-dispatch-${{ github.repository }}-${{ github.sha }}
  cancel-in-progress: false

jobs:
  dispatch:
    runs-on: ubuntu-latest
    if: ${{ vars.CLAWSWEEPER_COMMIT_REVIEW_ENABLED != 'false' }}
    env:
      HAS_CLAWSWEEPER_APP_PRIVATE_KEY: ${{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY != '' }}
      CLAWSWEEPER_APP_CLIENT_ID: Iv23liOECG0slfuhz093
    steps:
      - name: Create ClawSweeper dispatch token
        id: token
        if: ${{ env.HAS_CLAWSWEEPER_APP_PRIVATE_KEY == 'true' }}
        uses: actions/create-github-app-token@1b10c78c7865c340bc4f6099eb2f838309f1e8c3 # v3.1.1
        with:
          client-id: ${{ env.CLAWSWEEPER_APP_CLIENT_ID }}
          private-key: ${{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY }}
          owner: openclaw
          repositories: clawsweeper

      - name: Dispatch commit review
        env:
          GH_TOKEN: ${{ steps.token.outputs.token }}
          TARGET_REPO: ${{ github.repository }}
          BEFORE_SHA: ${{ github.event.before }}
          AFTER_SHA: ${{ github.sha }}
          CREATE_CHECKS: ${{ vars.CLAWSWEEPER_COMMIT_REVIEW_CREATE_CHECKS || 'false' }}
        run: |
          if [ -z "$GH_TOKEN" ]; then
            echo "::notice::Skipping commit review dispatch because no dispatch credential is configured."
            exit 0
          fi
          case "$CREATE_CHECKS" in
            true|TRUE|1|yes|YES|on|ON) create_checks=true ;;
            *) create_checks=false ;;
          esac
          payload="$(jq -nc \
            --arg target_repo "$TARGET_REPO" \
            --arg before_sha "$BEFORE_SHA" \
            --arg after_sha "$AFTER_SHA" \
            --arg ref "refs/heads/main" \
            --argjson create_checks "$create_checks" \
            '{event_type:"clawsweeper_commit_review",client_payload:{target_repo:$target_repo,before_sha:$before_sha,after_sha:$after_sha,ref:$ref,enabled:true,create_checks:$create_checks}}')"
          gh api repos/openclaw/clawsweeper/dispatches \
            --method POST \
            --input - <<< "$payload"
```

Disable the lane per target repo with:

```text
CLAWSWEEPER_COMMIT_REVIEW_ENABLED=false
```

Enable optional target commit check-runs with:

```text
CLAWSWEEPER_COMMIT_REVIEW_CREATE_CHECKS=true
```

The receiver waits 60 seconds before selecting commits by default. Adjust on
`openclaw/clawsweeper` only when needed:

```text
CLAWSWEEPER_COMMIT_REVIEW_SETTLE_SECONDS=60
```

Use `0` for settled manual backfills or a larger value during GitHub event
lag incidents.

Commit review is a background lane. It defaults to 1 commit per workflow page
when the system is quiet, but the receiver asks the central worker scheduler for
capacity before each page. Active repair, exact-item review, and sweep work can
lower the page size so commit review does not consume capacity needed by
maintainer-visible work. The checked-in default comes from
`config/automation-limits.json`; adjust the live workflow on
`openclaw/clawsweeper` only when the org has enough rate-limit headroom:

```text
CLAWSWEEPER_COMMIT_REVIEW_PAGE_SIZE=1
```

The receiver clamps this between 1 and 32. Setting the variable bypasses the
dynamic default for that run; leave it unset when the central scheduler should
decide. Large push ranges continue in later workflow pages.

`openclaw/clawhub` commit dispatches are skipped while
`CLAWSWEEPER_ENABLE_CLAWHUB` is not `1`. Turn that receiver variable on only
after the ClawSweeper GitHub App is installed on `openclaw/clawhub`; otherwise
the receiver cannot mint a target read token for commit review.

Manual reviews can be started from the `ClawSweeper Commit Review` workflow in
this repository. Inputs:

- `target_repo`: target repository, default `openclaw/openclaw`
- `commit_sha`: exact commit SHA
- `before_sha`: optional base SHA; when present, the workflow reviews every
  commit in `before_sha..commit_sha`
- `additional_prompt`: appended to the commit-review prompt for that run
- `create_checks`: create/update the target commit Check Run. Leave blank to
  use the receiver repo variable fallback; otherwise pass `true` or `false`.
  The effective default is `false`.
- `enabled`: emergency no-op switch

Large ranges are paged automatically. Each workflow run starts one matrix worker
per commit for up to GitHub's matrix limit, then dispatches the next page until
the whole range has one report per commit.

When enabled, the check name is `ClawSweeper Commit Review`. Clean
high-confidence reports use `success`; high-confidence high/critical findings
use `failure`; inconclusive or lower-confidence findings use `neutral`.
