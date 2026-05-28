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

For a PR that needs work, the visible comment starts with:

```text
Codex review: needs changes before merge.
```

For an external PR that lacks after-fix real behavior proof, the visible comment
starts with:

```text
Codex review: needs real behavior proof before merge.
```

The body should include the strongest actionable, non-overlapping sections the
report has:

- `**Summary**` from the typed `changeSummary` field, not from the
  merge verdict or maintainer follow-up summary; when `reproductionAssessment`
  is present, this section also includes a compact `Reproducibility:` line
- `**Real behavior proof**` near the top for PRs, from the typed
  `realBehaviorProof` field. When proof is missing, mock-only, or insufficient,
  this section should tell contributors that terminal screenshots, console
  output, copied live output, linked artifacts, recordings, and redacted logs
  count even for non-visual CLI or text changes. Ordinary app screenshots count
  only for behavior they directly show; browser runtime, network, CSP, and
  security proof needs visible diagnostic output, not a "no visible console
  violation" claim
- `**Next step before merge**` for PRs, or `**Next step**` for issues, from the
  work-candidate reason or next action
- `**Security**` from the typed `securityReview` field, so supply-chain,
  permission, secret-handling, and code-execution concerns have a dedicated
  visible pass; omit this section when the review is `not_applicable` and has
  no concerns
- `**Review findings**` for Codex `/review`-style findings, using typed priority,
  confidence, file, and line-range data from the report
- `Best possible solution:` only when it adds a distinct end-state that is not
  already covered by the next-step section
- `Acceptance criteria:`
- `What I checked:`
- `Remaining risk:` only when it is not a restatement of the required change or
  best solution

Actionable bullets in risk, finding, next-step, merge-blocking proof guidance,
acceptance criteria, and remaining-risk text may use plain priority prefixes
such as `[P0]`, `[P1]`, or `[P2]`. Keep those prefixes unbolded and attached to
plain-language consequences or required actions. Do not add priority prefixes to
audit-only details such as label justifications, AGENTS.md notes,
Mantis/workflow notes, model metadata, related people, PR stats, or generic
evidence lists.

Full review comments, source links, owner routing, acceptance criteria, and
evidence stay under the collapsed `Review details` block so the top-level PR
comment reads like a concise review.

Automerge and autofix state belongs in the command/status comment and hidden
markers, not in the public review section headings. A clean opted-in PR should
still read as `Codex review: passed.` in the durable review comment.

Issues use `**Next step**` instead of the PR-specific `**Next step before
merge**` heading. Non-PR comments are never repair triggers.

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
