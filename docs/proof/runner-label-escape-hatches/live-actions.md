# Live GitHub Actions runner override proof

Captured 2026-08-14 UTC for
[PR 1157](https://github.com/openclaw/clawsweeper/pull/1157).

## Behavior contract

With `CLAWSWEEPER_REPORT_RUNNER=ubuntu-latest`, dispatch the report workflow from the PR branch and
observe through the GitHub Actions API that the job resolves the configured label, receives a
GitHub-hosted runner, starts real steps, and completes. Compare that result with a prior run of the
same workflow showing the Blacksmith fallback. Leave the report override set, and do not create the
E2E or spam overrides.

## Route

The branch version of `maintainer-report-discord.yml` exposes `workflow_dispatch`, so the proof used
the report lane directly. GitHub tied the run to the requested PR branch and exact PR head; no
default-branch-definition fallback or precedent-only proof route was needed.

## Committed-object cross-check

The tested head, tree, and base were resolved by command substitution and checked with
`git cat-file` before dispatch evidence was committed:

```console
$ proof_head=$(git rev-parse HEAD)
$ proof_tree=$(git rev-parse 'HEAD^{tree}')
$ proof_base=$(git rev-parse origin/main)
$ printf 'proof_head=%s\nproof_tree=%s\nproof_base=%s\n' "$proof_head" "$proof_tree" "$proof_base"
proof_head=32334740ba22b0e7fe69d1c71bfc013441f3dbf6
proof_tree=8792b966061fe9aad1ba23ffe9d4a7704b9aa334
proof_base=dc738b3845655ad36f91ea9584d90abdd4df3ca3
$ printf 'proof_head_type=%s\n' "$(git cat-file -t "$proof_head")"
proof_head_type=commit
$ printf 'proof_tree_type=%s\n' "$(git cat-file -t "$proof_tree")"
proof_tree_type=tree
$ printf 'proof_base_type=%s\n' "$(git cat-file -t "$proof_base")"
proof_base_type=commit
```

## Variable and dispatch

```console
$ gh variable set CLAWSWEEPER_REPORT_RUNNER --repo openclaw/clawsweeper --body ubuntu-latest
$ gh variable get CLAWSWEEPER_REPORT_RUNNER --repo openclaw/clawsweeper
ubuntu-latest
$ gh workflow run 281699657 --repo openclaw/clawsweeper --ref steipete/runner-label-escape-hatches
https://github.com/openclaw/clawsweeper/actions/runs/31759075251
```

The run identity reported by `gh run view 31759075251 --json ...` was:

```json
{
  "conclusion": "success",
  "createdAt": "2026-08-14T00:57:31Z",
  "databaseId": 31759075251,
  "event": "workflow_dispatch",
  "headBranch": "steipete/runner-label-escape-hatches",
  "headSha": "32334740ba22b0e7fe69d1c71bfc013441f3dbf6",
  "name": "maintainer report to discord",
  "startedAt": "2026-08-14T00:57:31Z",
  "status": "completed",
  "updatedAt": "2026-08-14T00:58:12Z",
  "url": "https://github.com/openclaw/clawsweeper/actions/runs/31759075251",
  "workflowDatabaseId": 281699657
}
```

## Resolved label and runner pickup

The attempt-specific Actions jobs API avoids a stale cached first response. The final response was:

```console
$ gh api 'repos/openclaw/clawsweeper/actions/runs/31759075251/attempts/1/jobs?filter=all&per_page=100&page=1' --jq '<job projection>'
{
  "id": 94641313387,
  "name": "Summarize maintainer report",
  "status": "completed",
  "conclusion": "success",
  "started_at": "2026-08-14T00:57:35Z",
  "completed_at": "2026-08-14T00:58:12Z",
  "runner_id": 1011717149,
  "runner_name": "GitHub Actions 1011717149",
  "runner_group_id": 0,
  "runner_group_name": "GitHub Actions",
  "labels": ["ubuntu-latest"],
  "html_url": "https://github.com/openclaw/clawsweeper/actions/runs/31759075251/job/94641313387"
}
```

The `Set up job` step ran from `00:57:37Z` to `00:57:38Z`, and every workflow step, including
`Post report summary`, completed successfully. The non-null runner assignment plus completed setup
and checkout steps demonstrate pickup rather than a queued label-only result.

## Historical Blacksmith contrast

The most recent scheduled report run before this PR used `main` head
`4d41d3df4baf191dca9c385c82689425a135a5c4`:

```console
$ gh api repos/openclaw/clawsweeper/actions/runs/31688886472/attempts/1/jobs --jq '<job projection>'
{
  "id": 94411349909,
  "name": "Summarize maintainer report",
  "status": "completed",
  "conclusion": "success",
  "started_at": "2026-08-13T09:56:50Z",
  "completed_at": "2026-08-13T09:57:26Z",
  "runner_id": 12762319,
  "runner_name": "blacksmith-scale2-01kzx8ttr5349w912nmq4jtwqd-4vcpu",
  "runner_group_id": 5,
  "runner_group_name": "blacksmith runners 01kwyrrg4m5049hqd9h5a6vf13",
  "labels": ["blacksmith-4vcpu-ubuntu-2404"],
  "html_url": "https://github.com/openclaw/clawsweeper/actions/runs/31688886472/job/94411349909"
}
```

This is the same workflow and job, so it is a direct before/after contrast rather than evidence
borrowed from another lane.

## Variable end-state

```console
$ gh variable get CLAWSWEEPER_REPORT_RUNNER --repo openclaw/clawsweeper
ubuntu-latest
$ gh variable get CLAWSWEEPER_E2E_RUNNER --repo openclaw/clawsweeper
variable CLAWSWEEPER_E2E_RUNNER was not found
$ gh variable get CLAWSWEEPER_SPAM_RUNNER --repo openclaw/clawsweeper
variable CLAWSWEEPER_SPAM_RUNNER was not found
```

Result: the report override remains set to `ubuntu-latest`; the E2E and spam fallbacks remain
active because their variables are absent.

## Limits

This live proof exercises the report expression, runner assignment, and successful job execution.
It does not dispatch the E2E, containment, repair-publication, or spam lanes. Their exact expression
shapes remain covered by the committed workflow tests. No new Crabbox lease was needed for this
round; the earlier container proof lease `cbx_d1a06e39d867` is stopped as recorded in
`container-receipt.json`.
