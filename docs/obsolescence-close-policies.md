# Obsolescence Close Policies

Read when changing the default-off `stale_version_bug` or `obsolete_fix_pr`
apply gates. Review may propose either reason, but only `apply-decisions` may
close after fresh GitHub verification.

## Stale version bugs

`stale_version_bug` is issue-only. Enable it with
`CLAWSWEEPER_STALE_VERSION_BUG_CLOSE_ENABLED=true`. Review requires a bug at
least 120 days old, an outdated reported version/build or visibly replaced code
path, no current-release reproduction, no maintainer engagement, and no
protected or security-ish label.

Apply rechecks that the live issue is open and at least 120 days old, has no
assignee or milestone, fewer than 20 reactions, no open-linked-PR or
security-ish label, no maintainer comment, and no human comment in the last 90
days. Missing or failed GitHub reads keep the issue open. The close comment asks
for a current-release retest and promises reopening on a fresh reproduction.

## Obsolete fix PRs

`obsolete_fix_pr` is PR-only. Enable it with
`CLAWSWEEPER_OBSOLETE_FIX_PR_CLOSE_ENABLED=true`. Review requires a PR at least
90 days old, 30 days without current-head commit/status/check activity, at most
five changed files, no maintainer engagement, and evidence that every touched
path was rewritten or removed on the default branch after the PR head commit.

Apply rechecks live age, inactivity, changed-file count, assignment, requested
review, maintainer comments/reviews, and the dated head commit. It lists the PR
files once, then performs at most five default-branch commit lookups. A known
CI/workflow path with no later commit gets one contents lookup to prove a 404
deletion. Any unchanged path, incomplete response, malformed date, or API error
keeps the PR open. The close comment credits the contribution, names rewritten
or removed files, and invites a fresh PR against current `main` if needed.
