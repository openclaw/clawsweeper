# Implemented-on-main paired close policy

- Status: active
- Owner: ClawSweeper maintainers
- Owning code: `src/clawsweeper-status-context.ts` and `src/clawsweeper-apply-close-execution.ts`
- Update when: implementation-provenance, linked-issue, or paired-close guards change

`implemented_on_main` and `mostly_implemented_on_main` are destructive apply
paths. A review may identify semantic equivalence, but `apply-decisions` closes
only after fresh GitHub reads prove every required relationship.

## Required relationship

For a PR and exactly one same-repository linked issue, both independently
reviewed reports must cite the same high-confidence, GitHub-verified merged PR
on the default branch. At apply time, ClawSweeper re-reads the PR body and the
linked issue. The issue must still be open, and that exact cited same-repository
PR's current GitHub `closingIssuesReferences` relationship must contain the
still-open issue. The query excludes manually linked issues, and a generic
cross-reference (for example, `Related to #123`) is not closing provenance. A
missing, closed, unreadable, manually linked, or mismatched relation keeps both
items open.

This is intentionally stricter than semantic review evidence: a canonical PR
must have a durable GitHub relationship to the still-open linked issue before
ClawSweeper can close the pair. A canonical PR with no such relationship is
useful review context, but it does not authorize automatic paired closure. A
maintainer can evaluate that case through the ordinary review path.

## Mutation and visibility boundaries

Before any mutation, apply rechecks report freshness, source state, labels,
locks, and post-review human activity. The linked issue has its own mutation
lease and ledger record; it is archived before the parent PR, so an interrupted
parent close cannot erase an independently completed issue record.

The current close-reason policy and known same-author counterpart eligibility
are refreshed before the closeout note and again at the close mutation boundary,
bypassing candidate and generation caches. A counterpart that locks, reopens,
changes identity, or cannot be refreshed keeps the current item open. A prior
closed snapshot does not exempt a reopened counterpart from these checks.

These checks do not form a remote two-item transaction: GitHub can change after
the last read, and a later mutation can fail independently. The implementation
provenance path retains its issue-first ordering and independent issue archive.
General same-author pairs retain their existing processing order.

OpenClaw Bay is unaffected. Bay remains an observer-only projection of durable
workflow state: this policy changes neither Bay's public schema nor its ability
to initiate GitHub or apply actions.
