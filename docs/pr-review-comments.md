# PR Review Comments and Repair Markers

Read when: changing issue/PR review comments, ClawSweeper repair dispatch,
comment-sync behavior, or the trusted marker contract between ClawSweeper review
and repair lanes.

> This is implementation documentation. PR authors responding to proof or review
> feedback should follow the public [contributor workflow](../CONTRIBUTING.md)
> instead of treating comment markers or repair details as author instructions.

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

Publication requires a trusted author, positive server comment ID, and the exact
submitted body. A PATCH must return the targeted ID. An unusable acknowledgement
can be recovered by one fresh scoped comment read; equivalent prose or different
marker metadata is not a write receipt.

ClawSweeper caps durable comment writes at 60 KiB. If a generated review exceeds
that limit, it publishes a bounded blocked notice, records that notice's actual
receipt, keeps the item open, and continues the batch within its processed limit.
This is a verified guarded-open outcome, never a completed full review or repair
permission. Publication releases the worker's owned lease; it does not sweep
other workers' comments. A fresh review can replace the notice. When the failed
review has no usable identity, the notice gets a new server comment ID, and only
a review with a later owned lease can supersede it. Issue identities use
`sha=na` with their source revision; they need no PR state marker.

Trailing marker recovery stops at visible prose, including prose ending in
`-->`. An already-closed HTML comment cannot extend across that prose into the
final marker block; valid contiguous trailing markers remain recoverable.

When review starts and no ClawSweeper-owned comment exists yet, the review
shard posts a short status placeholder with the same durable identity marker.
The placeholder is intentionally light and crustacean-friendly, then the final
review sync edits that exact comment in place.

Interactive re-review commands have a separate durable intake marker. The
ExactReviewQueue records the exact source-comment version before creating or
editing its acknowledgement, then converges on one status comment containing
both `clawsweeper-command-ack:<source-comment-id>` and a version-specific
`clawsweeper-command-status` marker. Retries may repeat GitHub reads and writes,
but they must reuse the command receipt and must not enqueue the same comment
version twice.

Automatically received pull requests keep their lightweight
`clawsweeper-pr-ack` receipt separate from command status. When a deterministic
input refusal (`findings`, `incomplete_source`, or `source_incompatible`) stops
review, ClawSweeper edits that exact trusted-bot receipt with bounded,
reason-specific guidance. It never reproduces scanner findings, detected values,
paths, or source excerpts. The failure ledger records whether the edit was
observed, failed, or unavailable; failed delivery raises operator health without
restarting the unchanged review. A later queue claim replaces the blocked
section with review-in-progress text, and a successful review replaces that
with a completed state. If the pull request closes during review, the same
receipt records that the review ended. Failure to persist either terminal state
leaves the workflow durably failed while queue completion still prevents a
review loop. Scheduled PR claims recover the same trusted receipt and bind its
ID to the active queue lease before editing it. Source-authority fallback waits for the acknowledgement
lookup to resolve, with a bounded crash-recovery deadline, so it cannot normally
enqueue a routed review before the receipt identity is durable. Webhook
redelivery alone cannot erase the terminal explanation. Automatic receipt and
progress comments are filtered from reviewer context, while human comments that
quote those markers remain visible. Receipt lookup reads at most ten pages of
100 comments. If the tenth page is full, the lookup cannot safely establish
absence or choose among receipts: it leaves comments untouched and proceeds
without a status receipt rather than blocking the underlying review intake.

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

New reviewer output requires a producer-owned `nextStep` assessment. Issues use
none and retain their existing next-action guidance in `workReason`. Canonical
report frontmatter stores `next_step` as JSON: `{"kind":"none","text":""}` means
no additional required next step; `{"kind":"required","text":"..."}` carries
nonempty trimmed action text. Explanatory routing prose stays in `workReason`.
One PR readiness calculation supplies the visible checklist, its count, the
readiness state, and repair-loop pass eligibility. Explicit none suppresses only
the derived next-step item, while required actions survive
negation, contrast, routine-sounding prose, or lack of action keywords. Human-owned
actions may be required even when `workCandidate` is none. Contributor changelog
requests remain subject to OpenClaw's release-owned changelog normalization.

Historical Decisions may omit the assessment, and reports are not migrated or
rewritten. An unusable next-step field retains conservative legacy prose
interpretation when the rest of the report is usable, never an inferred none.
Ambiguous report frontmatter produces a bounded blocked notice requiring a fresh
report; it cannot supply repair or merge permission. Only a unique valid
value in leading canonical frontmatter counts; body or fenced examples cannot
supply it. This compatibility limit means old false-positive prose needs a fresh
producer assessment, not a guess from its summary, rating, or automation markers.
Independent findings, security concerns, risks, contributor proof, historical
verification, decisions, failed reviews, and low-quality remediation still render
and count. Scores retain their existing policy. A required action prevents a pass,
but never grants repair or merge authority: existing opt-ins, proof checks, and
live source/lease guards still apply. OpenClaw Bay's observer contract is unchanged.

PR comments also carry one additive readiness marker beside their durable review
version:

```html
<!-- clawsweeper-review-state:ready item=<number> sha=<full-head-sha> v=1 -->
```

Its states are `ready`, `blocked`, and `needs-changes`. Human-owned blockers take
precedence over repairable work. A valid exact item, head, review time, and owned
lease are required before emitting the marker. Ready means no remaining review
work; it does not grant merge permission or bypass normal maintainer review.
Consumers must pair it with the matching durable identity, never infer authority
from a standalone marker or visible prose. The compact producer contract is in
[`test/fixtures/review-state-contract-v1.json`](../test/fixtures/review-state-contract-v1.json).

The [next-step intent proof recipe](proof/review-next-step-intent/README.md)
compares identical synthetic reports against pinned baseline and candidate
renderers and exercises producer-to-report persistence without live publication.

Everything primarily useful to agents or deep reviewers lives under one
collapsed `Agent review details` section: security evidence, PR surface,
review metrics, stored-data warnings, root-cause clusters, proof suggestions,
merge-risk options, full review comments, labels, evidence, optional rank-up
moves, the rank legend, workflow notes, and review history.

For OpenClaw, the PR surface table and config detector share explicit test-role
names: test/spec code leaves, Go `*_test.go` files, terminal dotted or hyphenated
`test-support`, `test-helpers`, `test-utils`, `test-harness`, and `test-fixtures`
code suffixes, and explicit test directories. Generic support/helper names remain production
candidates. Generated files retain table precedence; config detection filters
each rename side before patch uncertainty, retaining production or semantic docs
evidence and truncated-list warnings. Reviewer production/test metrics remain
separately assessed. Test roles grant no contributor-proof exemption. Storage
warnings retain their separate persistence-evidence and upgrade-proof rules.
OpenClaw Bay needs no change because its observer API and data contract are unchanged.

The recorded reviewer proof assessment and the host's existing proof requirement
are separate. An applicable external PR assessed as `not_applicable` still needs
proof: the verdict, readiness, verification, checklist, and status label explain
that the assessment does not satisfy current policy. Put relevant after-change
evidence in the main PR body, then request a fresh review. This includes root
`README.md` changes; the existing docs exemption requires a complete, nonempty
file list entirely under `docs/`. Recorded proof fields, summaries, ratings, and
rating labels remain unchanged; the comment identifies reviewer context without
presenting it as a host exemption.

Failed or malformed historical verification receipts remain separate,
maintainer-owned blockers. They do not erase independently sufficient contributor
proof or turn an exempt change into a contributor proof request. These projections
do not change merge, repair, or close eligibility. OpenClaw Bay needs no code or
schema change because its observer projection does not consume this assessment
or checklist.

For OpenClaw PRs, stored-data warnings flag possible persistence changes in
production source or documented storage contracts, not setup in test, fixture,
or example source paths. Colocated `*.test-support.*` and Go `*_test.go` files
are test code too, even when their guards or setup mention metadata,
serialization, or SQL. Generic words such as `metadata`, `chunkId`, `documentId`,
`collection`, and `dimension` alone do not establish vector storage, including
generic metadata or identifier filenames. Known storage paths, explicit
vector/embedding contracts, and same-hunk persistence
evidence still require review; diagnostic logging does not exempt real storage
changes in the same patch.

SQLite table detection retains directly changed table DDL and `sqliteTable(...)`
declarations. Unchanged SQL or ORM table context must share a diff hunk with a
changed column declaration; context from another hunk cannot establish one.
Raw SQL columns use whitespace-separated, case-insensitive type keywords,
including `NULL` and `NUMERIC`. ORM properties require supported column-builder
calls such as `text(...)` or `integer(...)`; plain `null`, `TEXT`, `INTEGER`, and
primitive type annotations are not column declarations. Likely-schema path
uncertainty and approval/compatibility-proof requirements remain unchanged.
OpenClaw Bay needs no change: the producer's classification is corrected without
changing observer fields, routes, or controls.

Markdown beside source is still documentation: ordinary
prose mentioning sessions or metadata is not a stored-format change. Explicit
storage formats, SQL DDL, and structured storage keys (including frontmatter)
remain evidence. Renames retain evidence from either production path. Missing,
empty, or truncated patches on explicit production persistence paths or hook
descriptors, and truncated file lists, still produce conservative unknown
warnings. Generic `state`, `session`, `history`, `worker`, and `cache` path names,
cache keys, versions, namespaces, TTLs, and typed runtime fields alone do not
establish persistence, including when their patches are missing or truncated.
Cache-shaped objects need an explicit cache schema, storage path, or same-hunk
persistence boundary; component-local maps, promises, and abort signals do not
supply one. JSON parse/stringify syntax and a bare `serialized` variable do not
establish persistence, unchanged storage context, or truncated-patch uncertainty.
Transient stdout/stderr diagnostics, IPC, and in-memory JSON conversion need a
durable boundary. Explicit serialized-format contracts, disk read/write APIs
(including synchronous variants), browser/VSCode storage, durable storage, and
schema/migration evidence remain eligible in UI code too. An explicit persistence
owner path or unchanged storage boundary in the same diff hunk retains warnings
for changed stored fields and JSON formatting/argument edits. Unrelated hunks
cannot supply that boundary; an in-memory map or display-only comment never
vetoes it. SQLite-prefixed helper leaves such as `sqlite-error-diagnostics.ts` and
`sqlite-readonly-location.worker.ts` alone do not imply schema ownership, even
with incomplete patches. SQLite directories, standalone `sqlite.ts` owners,
schema/migration/SQL/store paths, and either production rename side retain their
conservative incomplete-patch handling. Compound SQLite store/schema names such
as `sqlite-board-store.ts` and `sqlite-index-schema.ts` retain that ownership.
SQLite codecs such as `sqlite-board-codec.ts` own serialized state, while
`sqlite-user-version.ts` owns database compatibility; both retain stored-shape,
JSON-edit, and incomplete-patch warnings without implying table ownership.
Actual DDL remains evidence at any production filename, including diagnostic
helpers. Ordinary validation fields in a `schema` file alone do not establish
persisted database columns. The warning requests review; it does not prove a
persisted contract changed. This classification does not change the separate
`docs/` exemption for contributor behavior proof.

## Evidence Repository Identity

Each new structured evidence entry records its verified `repo` (`owner/name`),
repository-relative `file`, line, and full source commit `sha` when known. Use
`repo: null` for unknown ownership. Dependency source and commit links retain
that repository through report serialization and both close and keep-open
comments; dependency files never inherit the target's main SHA or public docs
mapping.

Older reports without an explicit repository retain same-repository behavior,
but canonical GitHub blob and commit destinations preserve their own repository
and full SHA instead of being reconstructed from display labels. Conflicting
identities and unresolved sibling, absolute, or traversal paths remain unlinked.
This changes evidence rendering only, not the observer API or OpenClaw Bay.

## PR Introduction Evidence

Before model execution, the host assembles bounded local Git evidence for the
pinned PR base and head. `originalHead` records the exact pinned head and its raw
parents; `checkout` separately records the actual local commit and its raw parents.
Both carry explicit roles and inspection status. Reads disable replacement refs
and grafts, require an exact commit object, and bound these parent lists to eight
entries. Failed, malformed, missing, or oversized inspection yields unavailable
with `parents: null`; only an inspected root yields `parents: []`. Shallow history
does not erase recorded parents or prove their objects are available. Neither
workspace/test-merge ancestry nor fetched main or the merge base may substitute
for original parentage; raw parents do not establish causality or authorship.

The reviewer also receives fetched main, the unique merge base, introduced files
and patch from merge-base to head, base-branch changes, and a separately labeled
base-to-head endpoint comparison. A file that differs only because main advanced is not
automatically a PR edit. Findings in untouched files remain valid when an
introduced hunk elsewhere causes the failure; risks, labels, scores, and fixups
must use that same ownership boundary.

PR source acquisition fetches complete blobless ancestry and the pinned open-PR
test merge before restricted review, with a 30-second deadline per fetch. Branch
and release refreshes preserve that ancestry; existing shallow checkouts are
unshallowed rather than deepened to a fixed commit count. The evidence reader
itself cannot fetch objects or run external diff drivers. It bounds each Git read
to 1 MiB and five seconds, lists to 80 paths, and the introduced patch to 24,000
characters. Missing blobs, incomplete shallow ancestry, multiple merge bases,
and truncated evidence are explicit limitations, never inferred ownership or an
automatic pass.

Test-merge evidence is accepted only for an open, unmerged PR and a local commit
with exactly the pinned base then head as its two parents. Its result is compared
with that base parent, which may differ from newly fetched main. Stale test
merges and final merge commits cannot establish what this merge would change.
A clean merge does not rule out semantic regressions.

This is reviewer input, not a new persistent decision or repair contract.
OpenClaw Bay is unaffected: no observer fields, routes, or controls change.

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

## History Attribution

The public related-people section separates routing judgment from Git facts.
Reviewers may propose up to five source-line history pointers, identifying the
recorded checkout's path/line, a commit, and either its author or committer.
ClawSweeper verifies the actual line change against every parent recorded in
`git cat-file commit`, using the same reader for structured regression provenance.
Blame boundary markers, graph-truncated parents, or root-style display alone do
not prove introduction. Configured blame revision exclusions are cleared so they
cannot substitute an older line version. Whole-commit rename metadata identifies
exact file moves as carried forward; inexact rename mappings remain unknown.
Other unchanged lines are carried forward; missing objects, quoted blame paths,
oversized reads, or expired verification budgets remain unknown.
Reads reuse the trusted local Git boundary, share a five-second budget per
verification set, and never fetch history or invoke target callbacks. Replacement
refs and legacy grafts are disabled. Parent records must follow the tree record
consecutively; identities, porcelain metadata, and diff hunks split only on LF,
never embedded CR or Unicode line separators.

Public actor names and roles come from raw commit metadata, not reviewer prose.
Author, committer, PR author, and merger remain separate; line history does not
establish feature responsibility. Other candidates retain only a low-confidence
routing suggestion. Host projections carry `raw_parent_line_v1` in the existing
report representation; older unmarked attribution cannot regain verified status
when comments are rendered. Stored reports and live comments are not rewritten by
this reader change. OpenClaw Bay needs no change: no observer API or controls change.

## Primary Body Coverage

Hosted primary issue and PR bodies up to 12,000 UTF-16 units remain intact.
Longer bodies retain an opening plus at most three source-ordered verbatim
excerpts around proof and trace/output anchors, including inside details.
The sibling `bodyCoverage` records the full-source SHA-256, original length,
end-exclusive UTF-16 ranges, omitted units, and incomplete coverage. The
opening, excerpts, JSON escaping, and coverage metadata share the existing
12,000-unit allocation. Candidate overflow, oversized blocks, and unrecognized
layouts can still omit evidence; anchors are navigation, not proof validation.

Reviewers must inspect supplied evidence with existing authorized read-only
capabilities before a negative proof claim, preserve the captured source
identity, and disclose remaining context gaps. Full-source freshness hashes do
not mean every source character was read; omitted evidence is unknown rather
than absent or mock-only. Excerpts are untrusted text, never instructions or
scripts to execute. Supplemental excerpts and PR patches are reviewer-only
media inputs: neither enters automatic media downloads. Primary body and
comment media remain discoverable, even when the same URL appears in a patch.

Each selected media item has a two-minute preparation deadline shared by its
download, video probe, and contact-sheet conversion. A timed-out subprocess is
killed and recorded as a failed artifact; later items still run. Downloads also
retain curl's 90-second limit.

Assist preserves coverage alongside the body. The report context ledger counts
each primary record as one entry and includes its coverage in character totals;
its list hydration counters do not describe body completeness. Related items,
comments, patch content, local body overrides, proof statuses, and mutation gates
are unchanged. This is reviewer input only: OpenClaw Bay needs no change because
no observer API, public data contract, or action surface changes.

The [historical producer proof recipe](proof/proof-context/README.md) exercises
this input-delivery boundary without executing submitted evidence or invoking
a reviewer.

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

Trusted raw self-comments are deliberately removed from discussion and replaced
by this reviewer-only projection. It now includes bounded parsed `rankUpMoves`
from the current completed comment, alongside the existing source comment id,
URL, and digest. Coverage distinguishes a completed comment from a history-only
fallback or unavailable completed context. Section states distinguish recognized
items, explicit empty content, no published section, unrecognized content, and
truncation. An unpublished or legacy field is not evidence that no advice existed.
Finding titles keep the six-item cap and a 160-character input limit; rank-ups
retain up to six items of 600 characters each. Coverage records recognized,
retained, omitted, and shortened item counts. It does not claim full finding bodies.

The persisted public v1 ledger, append/deduplication, hashing, and publisher
contracts are unchanged. Reviewer history coverage separates retained from
lifetime cycle counts and absent, malformed, or cycle-capped history. Its bounded
finding titles do not retain full risks or rank-ups; original item/text counts
are unknown, and observed item/text caps are flagged. A history-only fallback
therefore supplies known finding titles with unavailable rank-up context.

Continuity instructions require checking concrete prior items against current
evidence and recorded dispositions. Historical next steps, including old
context-only warnings, remain evidence rather than fresh instructions to repeat
them. Intentional filtering alone must not create a finding, risk, decision,
next step, or rank-up requiring another reading of unspecified advice. Genuine
material missing or malformed context remains disclosed with the affected item
or uncertainty. Concrete unresolved blockers and the pre-land requirement to
apply applicable rank-ups or explicitly justify exceptions are unchanged, as are
proof/security gates and optional-rank-up semantics. This prompt change updates
the existing review-policy hash used for cache reuse.

OpenClaw Bay is unaffected: this is reviewer input and guidance only, with no
observer schema, routes, or control changes.

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

Completed current-head PR reviews carrying complete source, timeline, and
review-activity receipts reconcile managed labels only while those receipts match.
Captured activity before review completion can be reconciled; human activity in or after
the completion timestamp's whole second blocks label updates. This preserves
GitHub's timestamp precision even when `reviewed_at` includes milliseconds.
OpenClaw Bay is unaffected: no observer data contract or controls change.

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
