# Implemented-on-main paired close policy

- Status: active
- Owner: ClawSweeper maintainers
- Owning code: `src/clawsweeper-status-context.ts` and `src/clawsweeper-apply-close-execution.ts`
- Update when: implementation-provenance, linked-issue, or paired-close guards change

`implemented_on_main` and `mostly_implemented_on_main` are destructive apply
paths. A review may identify semantic equivalence, but `apply-decisions` closes
only after fresh GitHub reads prove every required relationship.

Only `implemented_on_main` intentionally has an exception to the generic
maintainer-author / `maintainer` label close hold. It does not exempt security
labels, explicit manual holds, locks, outstanding human decisions,
freshness, or any implementation evidence. Issue-only proposals still require
current source, history provenance, and release or current-main timing evidence;
PR and paired-issue proposals additionally require the GitHub relationships
below. This is not an exception for model-generated product rejection.

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
locks, and post-review human activity. Standalone issue closes also repeat the
full live freshness check at the close mutation boundary, even when no PR
coverage proof ran. A failed owned-comment receipt cannot excuse timestamp or
activity drift; the issue must remain open and unlocked. Receipt-backed
automation-only updates still require the complete original review identity
to match. Older issue reports without a stored timeline digest keep their
existing automation allowance only when a complete fresh scan finds no human
activity from the reviewed second and the stored reviewed source revision still
matches the live source. A report without reviewed source identity requires a
fresh review even when its durable comment already matches and no write is
needed. Same-second human timeline activity invalidates that receipt. The linked
issue has its own mutation lease and ledger record; it is archived before the
parent PR, so an interrupted parent close cannot erase an independently completed
issue record.

The current close-reason policy and known same-author counterpart eligibility
are refreshed before the closeout note and again at the close mutation boundary,
bypassing candidate and generation caches. A counterpart that locks, reopens,
changes identity, or cannot be refreshed keeps the current item open. A prior
closed snapshot does not exempt a reopened counterpart from these checks.

These checks do not form a remote two-item transaction: GitHub can change after
the last read, and a later mutation can fail independently. The implementation
provenance path retains its issue-first ordering and independent issue archive.
General same-author pairs retain their existing processing order.

The controlled standalone-issue proof is
`node scripts/e2e/apply-issue-close-freshness.mjs --artifact-dir .artifacts/issue-close-proof`
after `pnpm run build`. It runs the built production `apply-decisions` CLI with
one scratch report, a stateful loopback GitHub boundary, and isolated state and
archive directories. Repeated commands create distinct `run-*` generations
under the artifact directory, preserving earlier evidence. It records close PATCH
counts, source reads, report state,
and HTTP traces. It does not contact GitHub or establish a historical production
incident. The boundary is controlled, not a GitHub service integration test.
The unit suite reports all 17 scenarios independently rather than wrapping the
entire matrix in one subprocess timeout. Each scenario keeps the proof CLI
execution limit of 60 seconds; scenario timings and failures are recorded, and
cancellation shuts down the owned CLI process tree and boundary before cleanup.
This changes proof ownership, not production timeout or coverage policy.

OpenClaw Bay is unaffected. Bay remains an observer-only projection of durable
workflow state: this policy changes neither Bay's public schema nor its ability
to initiate GitHub or apply actions.
