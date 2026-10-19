# Obsolescence Close Policies

Read when changing the default-off `stale_version_bug` or `obsolete_fix_pr`
apply gates. Review may propose either reason, but only `apply-decisions` may
close after fresh GitHub verification.

## Stale version bugs

`stale_version_bug` is issue-only. Enable it with
`CLAWSWEEPER_STALE_VERSION_BUG_CLOSE_ENABLED=true`. Review requires a bug at
least 120 days old, an outdated reported version/build or visibly replaced code
path, no current-release reproduction, no maintainer engagement, and no
protected label or exact security label recognized by `isSecurityLabel` in
`src/repair/security-signals.ts`.

Apply rechecks that the live issue is open and at least 120 days old, has no
assignee or milestone, fewer than 20 reactions, no open-linked-PR or
security label, no maintainer comment, and no human comment in the last 90
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
keeps the PR open. Those path/date checks only nominate the PR; they do not prove the original
failure resolved or the contribution redundant.

Apply additionally requires a same-repository merged canonical PR reachable
from an exact current default-branch SHA, plus the independent PR close
coverage proof. That proof must inspect the complete original diff and current
source/tests, account for every useful behavior, regression test, and human
hold, and preserve the PR when useful residual work remains. A workaround,
related closed issue, changed filename, or runtime convergence alone is
insufficient. Missing source or incomplete history keeps it open.

The proof envelope binds the original head/body/comment snapshot, canonical
snapshot, prompt contract, and current-main SHA. Apply rechecks source activity
and the canonical/current-main snapshot after proof, after its own publication,
and before close; drift requires a fresh proof. These reads are optimistic
guards, not an atomic GitHub transaction. The close comment credits the
contribution and names the verified coverage.

Keep the live obsolete-fix flag false until the fixed revision is deployed,
old apply jobs with captured enabled environments are ruled out, and a dry run
has been reviewed. Re-enable only by an explicit reviewed rollout decision.
