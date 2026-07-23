# PR Review Comments and Repair Markers

Read when: changing issue/PR review comments, ClawSweeper repair dispatch,
comment-sync behavior, or the trusted marker contract between ClawSweeper review
and repair lanes.

## Purpose

ClawSweeper keeps one durable public Codex review comment per issue or pull
request. The comment is for maintainers first: it should explain the current
verdict, the concrete required change, what evidence was checked, and any
remaining risk.

For ClawSweeper repair PRs, the same comment also carries hidden HTML markers
that the repair lane can parse without relying on prose. ClawSweeper owns review
marker emission, branch mutation, duplicate guards, audit logging, and PR repair
inside this repo.

## Durable Comment Shape

Each synced comment includes the durable identity marker:

```html
<!-- clawsweeper-review item=<number> -->
```

ClawSweeper edits that comment in place instead of posting repeated comments.
Report front matter stores the synced comment id, URL, hash, and sync time.

When review starts and no ClawSweeper-owned comment exists yet, the review
shard posts a short status placeholder with the same durable identity marker.
The placeholder is intentionally light and crustacean-friendly, then the final
review sync edits that exact comment in place.

After a newer source revision wins its lease, ClawSweeper may delete dedicated
review-start placeholders for older revisions. The candidate comment snapshot
is captured first, then the worker must still own the exact queue
item/lease/revision/generation/run tuple and the live item revision must match
its lease. For pull requests, the claimed queue source head must also match the
live head. A stale worker therefore cannot treat a newer lease as superseded
just because the SHAs differ. Same-revision contenders still use the
server-assigned comment-id election, and expired leftovers retain the existing
conservative cleanup path.

For a PR that needs work, the visible comment starts with:

```text
Codex review: needs changes before merge.
```

The visible `Summary` also includes `Reviewed head: <full-sha>`. This makes the
human-facing verdict self-identifying without requiring maintainers to inspect
hidden markers. Publication still verifies the durable tuple against live state;
the visible SHA is evidence of the captured review revision, not a substitute
for that guard.

For an external PR that lacks after-fix real behavior proof, the visible comment
starts with:

```text
Codex review: needs real behavior proof before merge.
```

PR comments use a human-first shape:

1. `## What this changes` is first. It comes from the typed `changeSummary`
   field and should define unfamiliar subsystem terms briefly and explain the
   effect in plain language.
2. `## Merge readiness` comes directly after the change summary. It leads with
   one dynamic plain-language outcome, the number of real items remaining, a
   short bottom line, priority, and an owner-decision pointer only when a
   decision packet exists.
3. `## Review scores` separates the three ratings into a scannable
   `Measure | Result | What it means` table. Crab ranks stay visible, but every
   ranked value also shows its six-point score: S is `6/6`, A is `5/6`, B is
   `4/6`, C is `3/6`, D is `2/6`, and F is `1/6`.
4. `## Verification` folds proof, concrete evidence/checks, findings, and
   security into one compact `Check | Result | Evidence` table. Uneventful
   findings and security rows say `None.`
5. `## How this fits together` appears when the review can establish concrete
   system context. It uses one or two plain-language sentences plus a compact
   Mermaid flowchart showing the changed subsystem's inputs, decisions, and
   outputs.
6. `## Decision needed` appears only when a maintainer decision packet exists.
   It shows the concrete question and recommended option in a table.
7. `## Before merge` uses native Markdown task checkboxes for real remaining
   actions or risks. Routine CI, ordinary maintainer review, and no-op guidance
   collapse to `None.`
8. `## Findings` appears only when actionable review or security findings need
   a little more visible detail.

Everything primarily useful to agents or deep reviewers lives under one
collapsed `Agent review details` section: security evidence, PR surface,
review metrics, stored-data warnings, root-cause clusters, proof suggestions,
merge-risk options, full review comments, labels, evidence, optional rank-up
moves, the rank legend, workflow notes, and review history.

Security defaults to `None.` when there are no concerns. Do not spend public
space explaining why an uneventful security pass is uneventful.

Concrete blockers or required work in risk, finding, next-step,
merge-blocking proof guidance, acceptance criteria, and remaining-risk text may
use plain priority prefixes such as `[P0]`, `[P1]`, or `[P2]`. Keep those
prefixes unbolded and attached to plain-language consequences or required
actions. Do not add priority prefixes to non-actions such as `none`, routine
maintainer review, normal CI/status-check follow-up, or audit-only details such
as label justifications, AGENTS.md notes, Mantis/workflow notes, model metadata,
related people, PR stats, or generic evidence lists.

Full review comments, source links, owner routing, acceptance criteria, and
evidence stay under the collapsed `Agent review details` block so the top-level
PR comment reads like a concise review.

Automerge and autofix state belongs in the command/status comment and hidden
markers, not in the public review section headings. A clean opted-in PR should
still read as `Codex review: passed.` in the durable review comment.

Issues use `**Next step**` instead of the PR-specific `**Next step before
merge**` heading. Non-PR comments are never repair triggers.

## Review History Ledger

Because ClawSweeper edits one durable comment in place, each sync would
otherwise erase what earlier review cycles asked for. PR keep-open comments
therefore carry a compact ledger of earlier cycles inside a collapsed
`Review history` block, anchored by:

```html
<!-- clawsweeper-review-history v=1 total=<completed-earlier-cycle-count> -->
```

Each ledger line records one completed earlier cycle: reviewed-at timestamp,
reviewed head sha, verdict, and finding titles. The marker's `total` attribute
keeps the lifetime count when the visible ledger is capped. When the apply lane
syncs a fresh review over an existing comment, it parses the existing ledger,
appends the review it is replacing as the newest earlier cycle, and keeps the
last eight cycles. Re-syncing the same review (same `reviewed_at`) does not add
a cycle. A stale-head warning keeps the displaced review in this ledger rather
than erasing its findings before the fresh review runs.

The review lane feeds the parsed ledger back to the reviewer as
`previousClawSweeperReview.earlierReviewCycles` plus a
`completedReviewCycles` count, and the review prompt requires re-review
continuity: verify prior findings first, report every remaining blocking
concern in one pass, and mark findings on previously reviewed, unchanged code
with `lateFinding: true` only after comparing the current file with an earlier
reviewed SHA, so review churn stays measurable without guessing from titles or
line numbers.

## Repair Markers

For an actionable PR repair request, ClawSweeper appends both markers:

```html
<!-- clawsweeper-verdict:needs-changes item=<number> sha=<pull-head-sha> confidence=<confidence> -->
<!-- clawsweeper-action:fix-required item=<number> sha=<pull-head-sha> confidence=<confidence> finding=review-feedback -->
```

The verdict marker says what the review decided. The action marker is the
permission for the repair lane to wake up. If the action marker is absent, the
repair lane must not start a repair run.

For a PR whose typed `securityReview.status` is `needs_attention`, ClawSweeper
must emit a deterministic security marker and a human-only verdict, never a
repair or pass marker:

```html
<!-- clawsweeper-security:security-sensitive item=<number> sha=<pull-head-sha> confidence=<confidence> -->
<!-- clawsweeper-verdict:needs-human item=<number> sha=<pull-head-sha> confidence=<confidence> -->
```

For failed reviews, ambiguous reviews, or PR comments that should stay in human
hands, ClawSweeper emits a human-only verdict:

```html
<!-- clawsweeper-verdict:needs-human item=<number> sha=<pull-head-sha> confidence=<confidence> -->
```

Missing, mock-only, or insufficient `realBehaviorProof` is always human-only:
ClawSweeper must not emit `clawsweeper-action:fix-required` or pass/automerge
markers for proof-only blockers because automation cannot prove the
contributor's real setup for them.

Clean/close-style PR verdicts also stay human-only from the repair point of
view. Closing remains outside the repair loop.

## Stale-Head Guard

PR reports include `pull_head_sha` in front matter when GitHub provides it.
ClawSweeper copies that SHA into the hidden markers. The repair lane compares
the marker SHA with the live PR head SHA and skips the comment if they differ.

This keeps an old review comment from repairing a branch after the PR already
moved.

## Iteration Limits

ClawSweeper caps trusted repair dispatches:

- `CLAWSWEEPER_MAX_REPAIRS_PER_PR=10` total automatic repair
  iterations per PR by default.
- `CLAWSWEEPER_MAX_REPAIRS_PER_HEAD=2` repair dispatches per PR head
  SHA by default.

The per-head cap prevents unbounded duplicate workers for the same commit while
leaving room for one infrastructure retry. The per-PR
cap stops an automatic review/repair loop after ten ClawSweeper-triggered
iterations even if each repair pushes a new head SHA.

## Operational Notes

- ClawSweeper should generate actionable text for maintainers and structured
  markers for automation. Do not make repair automation depend on exact prose
  when a marker exists.
- Sync comments without closing by running apply in comment-sync mode:

```bash
pnpm run apply-decisions -- --target-repo openclaw/openclaw --sync-comments-only --comment-sync-min-age-days 7 --processed-limit 1000 --limit 0
```

- Normal review/apply workflows also refresh missing or stale durable comments.
