# Stalled PR Close Policies

Two PR-only close reasons handle external pull requests that stop making
progress: `stalled_unproven_pr` and `abandoned_pr`. Both are review-proposed
and apply-guarded like every other close reason: review records the proposal,
and apply re-checks live GitHub state immediately before any mutation.

Both reasons are for non-maintainer pull requests only. Maintainer-authored
PRs, protected labels, and the standard exemption labels
(`clawsweeper:human-review`, `clawsweeper:manual-only`, `clawsweeper:autofix`,
`clawsweeper:automerge`) always block them.

## `stalled_unproven_pr`

An external PR was asked for real-behavior proof, the ask expired, and the
branch is low-rated and idle.

Review may propose it only when all of these hold:

- `realBehaviorProof.status` is `missing`, `mock_only`, or `insufficient`;
- `prRating.overallTier` is `D` or `F`;
- the proof requirement is visible on the PR (ClawSweeper review comment,
  proof nudge, or a needs-proof label).

Apply additionally verifies live state:

- the PR is older than 14 days and its head shows no new commit or check
  activity for 14 days (the inactivity clock takes the newest of the head
  committer date and status/check-run timestamps, so pushing an old commit
  still counts as fresh activity);
- a dated proof request is visible on the PR — a needs-proof label timeline
  event or a proof-nudge comment — and that request is at least 14 days old,
  so the contributor had a real window to respond. The durable review comment
  is edited in place and cannot date the ask, so it does not count;
- the PR is not a draft (drafts route to `abandoned_pr` instead);
- no `proof: sufficient` or `proof: override` label is present;
- no human engagement: no assignee, requested reviewer/team, or
  maintainer comment/review/inline comment.

The close comment names the missing proof kind and invites reopening with a
live run, logs, or a reproducible validation transcript. The
[proof-nudge lane](proof-nudges.md) remains the polite warning step and still
never closes anything itself.

## `abandoned_pr`

An external PR has clearly been abandoned in a non-landable state.

Review may propose it for stalled external PRs, but not for high-quality
proven work: an `S`/`A`/`B` overall rating with sufficient or overridden proof
blocks the reason because that work belongs in repair/adopt paths.

Apply additionally verifies live state:

- the PR is older than 30 days and its head shows no new commit or check
  activity for 30 days, using the same push-safe inactivity clock as
  `stalled_unproven_pr`;
- the live PR is still stalled: a draft, labeled
  `status: ⏳ waiting on author`, or failing checks
  (combined status failure/error, or a check run concluding
  `failure`/`timed_out`) on its current head;
- no human engagement, same checks as above.

The close comment acknowledges the useful part of the work, states the
observed inactivity window and stalled state, and invites a rebased reopen or
a fresh PR with green checks.

## Failure posture

Live-state probes run through safe wrappers: if any GitHub read fails, the
apply run records a skip reason and keeps the PR open. Snapshot drift rules
still apply — any new commit, comment, or label change since the review blocks
the close until a fresh review confirms the proposal.
