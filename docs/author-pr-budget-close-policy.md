# Per-Author Open-PR Budget Close Policy

Read when changing automatic trimming for external authors with unusually large
open pull-request backlogs.

`author_pr_budget_exceeded` is PR-only and dark by default. The review path does
not fetch an author's repository-wide open-PR count: doing so would add one
GitHub Search request to every PR review. Reviews may propose the reason only
when that count is already present in context. Normally, apply promotes an
eligible kept-open report after deterministic live verification.

Enable closes with
`CLAWSWEEPER_AUTHOR_PR_BUDGET_CLOSE_ENABLED=true`. The live budget defaults to
15 and can be overridden with `CLAWSWEEPER_AUTHOR_PR_BUDGET`. The policy closes
at most five PRs per author per apply run; override that gradual-trim cap with
`CLAWSWEEPER_AUTHOR_PR_BUDGET_MAX_CLOSES_PER_RUN`.

Apply requires all of these conditions:

- external author association, never `OWNER`, `MEMBER`, or `COLLABORATOR`;
- more live open PRs than the configured budget, from one bounded GitHub Search
  query for the candidate;
- a D/F overall rating or missing, mock-only, or insufficient real behavior
  proof;
- PR age of at least seven days and no current-head commit, status, check-run,
  source-run, or force-push activity for at least seven days;
- no protected or PR auto-close-exempt label and no maintainer assignment,
  requested review, comment, review, or inline review comment.

S/A/B-rated PRs with sufficient or overridden proof always stay open. Missing,
malformed, incomplete, or failed GitHub reads fail closed. Trusted-comment
routing never performs this close directly; `apply-decisions` owns the live
count, inactivity proof, and per-run cap.

The close comment reports the live count and budget, identifies the PR as a
lowest-signal trim, explains that finishing or closing other PRs frees budget,
and invites reopening once the author is under budget or real proof is added.
