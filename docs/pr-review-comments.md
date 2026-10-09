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

A newly completed exact-head re-review refreshes the existing comment's
`reviewed_at` and review-version marker even when its verdict and prose are
unchanged. Reapplying that same completed review remains idempotent; item-update
and lease-only metadata do not independently require a comment rewrite.

ClawSweeper-owned placeholders, acknowledgements, lease comments, and edits to
those comments are excluded from reviewed discussion/source activity. Human
comments quoting the same markers remain source activity. The separate PR
review-activity cursor covers PR reviews, inline comments, and review
thread resolution, not ordinary issue comments. When that cursor changes, apply
logs `reviewed_pr_activity_cursor_drift` with the expected and two observed
version/count/digest cursors, distinguishing stable drift from a change between
reads. It never logs review bodies and still refuses publication on drift.

Explicit manual reports carry `publication_policy: record_comment_only`. Their
publisher permits the selected durable comment and canonical report/plan/packet
tuple, plus owned coordination. It suppresses automation action markers and
label synchronization, closes, paired-item writes, repair, and implementation.
The completion identity/version and original `reviewed_at` remain intact after
an accepted comment write. Retrying publication does not make the review newer;
unknown acknowledgements still require the exact trusted read-back described
below. The coordinator checks current publication authority without extending
expired claims, and records router disposition as `not_required`.
It checks the actual lease/run/attempt or active batch owner at each comment
mutation attempt, including lease cleanup, and checks ownership again before
canonical acceptance after asynchronous admission. These checks do not make
GitHub and the coordinator one atomic transaction: an accepted comment may
precede a rejected canonical handoff if ownership changes between services.
An absent new restricted report fails as `missing_record_tuple`; hydrated old
canonical content cannot supply the missing review authority. Ordinary absent
reports keep their terminal missing disposition. Cached reports are reusable only
under a matching publication policy; an incompatible cache requires a fresh
review rather than relabeling the cached provenance. Marker-suppressed comments
that exceed 60 KiB are refused before any write, so the ordinary oversized
fallback cannot introduce automation markers or a replacement completion claim.

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

Scheduled and other non-command review workers coordinate through a separate
temporary `clawsweeper-review-lease` comment; final publication updates the durable
review and removes the owned lease. Command-triggered exact reviews rewrite their
existing command acknowledgement and use the durable queue claim directly, without
posting a second visible lease comment. The acknowledgement lease records the
claimed decision's source head; router-dispatched autofix/automerge commands carry
none, so the lease uses the live PR head read during admission, or the head in the
command status marker when that read failed. A lease with no valid head fails before
any comment edit. If that acknowledgement cannot be resolved,
they fall back to the temporary lease path. Exact-review workers check queue ownership
before GitHub comment work and again before generation and finalization. A definitive ownership rejection completes
as superseded without retrying. A transport or service failure retries the check;
the same authorized run reuses its own active lease instead of posting another
status comment. Exhausted service failures remain failures for normal queue
recovery, not successful supersession. Other workers' leases remain protected.

Interactive re-review commands have a separate durable intake marker. The
ExactReviewQueue records the exact source-comment version before creating or
editing its acknowledgement, then converges on one status comment containing
both `clawsweeper-command-ack:<source-comment-id>` and a version-specific
`clawsweeper-command-status` marker. Retries may repeat GitHub reads and writes,
but they must reuse the command receipt and must not enqueue the same comment
version twice.

Automatically received pull requests keep their lightweight
`clawsweeper-pr-ack` receipt separate from command status. When a deterministic
input refusal (any non-retryable agent-input scan reason, or `source_incompatible`) stops
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

The visible `Merge readiness` also includes `Reviewed head: <full-sha>`. This makes the
human-facing verdict self-identifying without requiring maintainers to inspect
hidden markers. Publication still verifies the durable tuple against live state;
the visible SHA is evidence of the captured review revision, not a substitute
for that guard.

For an external PR that lacks after-fix real behavior proof, the visible comment
starts with:

```text
Codex review: needs real behavior proof before merge.
```

PR comments use a verdict-first shape. The visible part answers "should this
merge, and why not yet" in this order:

1. The verdict line (`Codex review: ...`).
2. `## What this changes` comes from the typed `changeSummary` field and
   should define unfamiliar subsystem terms briefly and explain the effect in
   plain language. When the typed `changeExample` has a scenario, before,
   and after, an `Example:` block shows that concrete case under the summary.
3. `## Review scores` separates the three ratings into a scannable
   `Measure | Result | What it means` table. Crab ranks stay visible, and every
   ranked value also shows its six-point score: S is `6/6`, A is `5/6`, B is
   `4/6`, C is `3/6`, D is `2/6`, and F is `1/6`. The `Proof confidence` row
   shows the rated proof summary. When the contributor proof gate does not
   apply, the tier stays rated and the row says what proof exists, not "Not
   applicable"; only an `NA` tier reads "Not applicable". When missing proof
   blocks merge, the row only points to `Before merge`, which owns the proof
   ask. Evidence entries that only repeat the proof statement are dropped, and
   label justifications state only the label meaning. The rating scale and
   workflow notes in the details are one line each.
4. `## Product` shows the typed `productReview` in one compact block: kind,
   worth it, fix scope (omitted when not applicable), user problem, and reason.
   Reports written before `productReview` existed omit the section.
5. `## Regression provenance` appears only when a verified or suspected
   regression source exists.
6. `## Merge readiness` leads with one dynamic plain-language outcome, the
   number of real items remaining, a short bottom line, priority, the reviewed
   head, and an owner-decision pointer only when a decision packet exists.
7. `## Decision needed` appears only when a maintainer decision packet exists.
   It lists the concrete question, the recommended option (or every option when
   none is recommended), and why, as bullet points.
8. `## Before merge` uses native Markdown task checkboxes for real remaining
   actions or risks. Routine CI, ordinary maintainer review, and no-op guidance
   collapse to `None.` These items are the one source of merge readiness: the
   PR status label is `status: 👀 ready for maintainer look` only when this
   section is `None.`, and `status: ⏳ waiting on author` when an item needs
   changes from the author. When a duplicate close is kept open because the
   close check did not confirm coverage, the item asks a maintainer to close or
   keep the PR, not the author.
9. `## Findings` always renders for completed reviews. Its leading block lists
   up to three review findings and three security concerns as
   `- [P1] title — \`file:line\``, or `None.`; review history and the comment
router parse only this block. A `### Provenance`subsection lists`overrides_without_reason`and`unknown`provenance entries, and a`### Tests` subsection lists low-value tests (file and reason) and the
   missing end-to-end scenario. Neither subsection uses P-severity labels, so
   neither starts repair routing.

Maintainer decision packets are reserved for unresolved choices between at least
two distinct viable options that evidence cannot settle and a maintainer has not
already decided. Routine landing approval, PR size, and PR-body merge/sign-off
notes do not create decisions or Before-merge blockers. A recorded design decision
cited in a maintainer-authored PR counts as accepted within its current scope.
Stored-data changes require compatibility evidence, not human acknowledgement.
Codex records this in `realBehaviorProof.dataModelCompatibility`; only
`insufficient` adds the `Add data-model compatibility proof` blocker. The host
does not classify paths or patches for config or stored-data changes. Defects,
security concerns, missing proof, and undecided product or plugin API direction
still block. Readiness does not itself grant merge authority.

The review prompt keeps evidence-backed implementation choices with the PR owner:
individually source-verified oracle/snapshot/baseline exceptions for tool-owned
metadata that preserve exact user data without masking regressions; recovery
removal of only invalid or unreachable data after a verified backup,
with counts reported and valid data untouched; and ownership, ordering, or
internal transaction/lifecycle choices within an authorized maintainer
repair-and-land request. The PR body records the choice and evidence, which the
review verifies. These choices do not request design acceptance or create a
`Resolve maintainer decision` item, including through product review or risk
fields. Broad exceptions and missing data-model compatibility proof still need
PR-owner action. Unresolved new config options, breaking public API/SDK changes,
new schemas/tables, changed retention of valid data, and paid services retain
the maintainer-decision requirement. This changes reviewer guidance only;
OpenClaw Bay's observer fields, routes, and controls are unchanged.
The OpenClaw profile supplies the Doctor examples for these choices.

PR reviews use `prompts/review-item-pr.md`, whose `Review Rules` section
guides three typed assessments: `productReview`
(kind, user problem, fix scope, `worthIt`), `provenance` (the introducing commit
or PR and stated reason for each changed behavior), and `testingReview` (proof
path, low-value tests, missing end-to-end scenario). `worthIt: no` and
`worthIt: needs_maintainer` add blocked Before-merge items; each
`overrides_without_reason` provenance entry adds a needs-changes item asking the
author to explain or restore the original intent. Low-value tests never block.
The rating is the reviewer's judgement: the rules rubric tells the model how
weak proof, low-value tests, product calls, partial fixes, and unexplained
overrides should weigh, and code applies no tier caps from these fields. Reports
written before these fields existed parse as `not_applicable` and keep their
stored rating and readiness.

The review checkout is a `blob:none` partial clone, and the review proxy allows
only read methods, so Git's lazy object fetch (a smart-HTTP `POST`) fails there
with HTTP 403. Before the model runs, the host makes the history of the PR's
changed files local: one `git log --raw` walk from the head, base, GitHub test
merge, and fetched main tip lists every version of the changed files (up to
100), newest first, and one noop-negotiation fetch downloads the missing blobs.
It also fetches the files deleted in each file's creation commit, detects renames
among them, and repeats the walk for up to two generations of earlier names, so
`git log -S/-G/-L`, `git show <old>:<path>`, and `git blame` work in the sandbox.
The bound is 5,000 blobs, 1 GiB estimated (the largest local version of a path
times its versions), 128 MiB estimated per path, and 60 seconds; a path cut by a
bound keeps its newest versions, and an earlier name that could not be checked
counts as a cut. On openclaw/openclaw the full history of 2 to 20 changed files
and their earlier names is 160 to 1,058 blobs, 0.3 to 6.6 MiB, in 2.5 to 12 seconds.
The prompt's Runtime Capabilities line names the earlier file names and any
history that was not prefetched. Behind the allowlisted proxy (codex runner,
`clawsweeper-review` sandbox) the reviewer runs with `GIT_NO_LAZY_FETCH=1`, so any
other missing blob fails at once with `lazy fetching disabled` instead of a 403;
`git log --follow` still ends with that error at a file's creation commit, because
its copy detection reads the whole parent tree. The unrestricted OpenClaw runner
keeps lazy fetch, so reads beyond the prefetch still download on demand.

The host also computes the PR prompt's `## Provenance Evidence`: from the merge-base to head diff it
takes up to 12 files that existed on the merge base (most modified or deleted
base lines first, at most 4 hunks each; a pure insertion contributes the up to
three unchanged base lines around it as `insertion_context`). It runs
`git blame --porcelain` on those base lines at the merge base, reading the
prefetched history (lazily fetching anything beyond its bounds on the host),
all within one 45-second deadline, and resolves up to
15 distinct introducing commits through
`GET /repos/{owner}/{repo}/commits/{sha}/pulls` with the same `gh` reader that
collects item context (title, URL, merge time, 1,200-character body excerpt,
cached per run). Deadlines, Git errors, and API errors degrade the evidence to
`partial` or `unavailable` with a reason; the review still runs. The evidence
supplies facts only: the model still decides each provenance verdict.

The parser rejects required packets with fewer than two options or duplicate
options; malformed reports remain fail-closed and need a fresh review, rather
than silently losing a possible real blocker. Semantic intent belongs to the
review producer, not keyword filtering in comment rendering. Packet synchronization
removes an invalid report's derived sidecar and pointer without changing its
decision or hold, so legacy packets cannot abort archive, reopen, or closed-sidecar
reconciliation for other records. Filesystem errors still propagate.
Issue comments render a fresh-review notice for invalid stored decisions; PRs
retain their malformed-report blocker. OpenClaw Bay needs
no code or schema change: the packet fields and observer projection are unchanged.

New reviewer output requires a producer-owned `nextStep` assessment. Issues use
none and retain their existing next-action guidance in `workReason`. Canonical
report frontmatter stores `next_step` as JSON: `{"kind":"none","text":""}` means
no additional required next step; `{"kind":"required","text":"..."}` carries
nonempty trimmed action text. Explanatory routing prose stays in `workReason`.
One PR readiness calculation supplies the visible checklist, its count, the
readiness state, and repair-loop pass eligibility. Explicit none suppresses only
the derived next-step item, while required actions survive
negation, contrast, routine-sounding prose, or lack of action keywords. Human-owned
actions may be required even when `workCandidate` is none. Code does not remove
or rewrite model findings, next steps, risks, correctness, or ratings.

Historical Decisions may omit the assessment, and reports are not migrated or
rewritten. An unusable next-step field retains conservative legacy prose
interpretation when the rest of the report is usable, never an inferred none.
Ambiguous report frontmatter produces a bounded blocked notice requiring a fresh
report; it cannot supply repair or merge permission. Only a unique valid
value in leading canonical frontmatter counts; body or fenced examples cannot
supply it. This compatibility limit means old false-positive prose needs a fresh
producer assessment, not a guess from its summary, rating, or automation markers.
The producer keeps only unresolved concerns in `risks`: each entry becomes a
blocking checklist item. Explicit maintainer acceptance resolves only the
specific tradeoff it covers at the reviewed change. The limitation and cited
decision remain visible in evidence and any applicable merge-risk label rationale;
they do not reopen the same decision or populate `mergeRiskOptions`. A nonempty
merge-risk label list therefore permits empty options when `risks` is empty;
labeled unresolved risks still require options. Proposed or conditional acceptance, contributor assertions, and changed scope remain
unresolved. The renderer does not infer acceptance from prose or labels, and
historical reports require a fresh review to change their assessment. Acceptance
does not grant merge authority or waive enforced gates.

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

Everything else lives under one collapsed `Agent review details` section, in
this order: how this fits together (system context and Mermaid flowchart), live
verification, technical review (best solution, reproduction and solution
questions, full review comments, AGENTS.md status, remaining risk), merge-risk
options, provenance entries that respect or explain the original intent, the
testing proof path, security, evidence (security concern detail, acceptance
criteria, what was checked, likely related people tied to a verified commit;
unverified routing candidates are not published), PR surface, review metrics
(only when present), stored-data warnings, root-cause clusters, proof
suggestions, labels, optional rank-up moves, a one-line rating scale, a
one-line workflow note, and review history.

The label section explicitly says `No label changes.` when the publisher supplies
confirmed previous labels, the review is not failed, and owned-label
justifications remain but there are no add/remove transitions. Report metadata
alone does not establish this no-op claim. Existing nonempty transitions and
automation markers are unchanged.

For OpenClaw, the PR surface table uses explicit test-role names: test/spec code
leaves, Go `*_test.go` files, terminal dotted or hyphenated `test-support`,
`test-helpers`, `test-utils`, `test-harness`, and `test-fixtures` code suffixes,
explicit test directories, and native app test targets (Swift `*Tests/`
directories and Gradle `src/test*/` and `src/androidTest*/` source sets). Source
roots are `src/`, `ui/`, `packages/`, `extensions/`, and `apps/` (native Swift and
Kotlin apps). The summary line adds `Added test files: N`, counting only test-role
files whose GitHub status is `added`; reports written before file status was
stored omit it. Generic support/helper names remain production candidates.
Generated files retain table precedence. Reviewer production/test metrics remain
separately assessed. Test roles grant no contributor-proof exemption.

Codex assesses stored-data compatibility in
`realBehaviorProof.dataModelCompatibility`, independently of general behavior
proof. The report writer persists it as the canonical
`real_behavior_proof_data_model_compatibility` field. Summaries, evidence prose,
ratings, general proof sufficiency, `proof: override`, maintainer/bot authorship,
and a `not_applicable` proof status cannot waive an `insufficient` assessment. Reports without
the field add no stored-data blocker.

The reviewer model decides whether real behavior proof applies. For an external
PR, the proof gate accepts `sufficient`, `override`, or `not_applicable`, unless
the model also sets `needsContributorAction` or starts the proof summary with the
authority-chain marker. File paths do not change this decision; the review rules
tell the model to use `not_applicable` for docs-only PRs. A report without a
usable proof assessment for an external PR counts as `missing` proof. A report
without a usable PR rating shows `NA` tiers and asks for a fresh review; code does
not compute a replacement rating, and an attached verification receipt does not
change the model's tiers.

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

The word `doctor` can name a read-only diagnostic route. It requires a known
persistence owner or storage evidence in the same diff hunk before producing a
migration warning; unrelated storage elsewhere in the file does not qualify.
Documentation describing an explicit persisted contract also retains doctor
warnings. Explicit migration, backfill, repair, and persisted-shape evidence remain eligible.

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
durable boundary. A complete single-line `const` declaration constructing the directly imported
`node:console` `Console` with `stdout` and `stderr` bound to process streams is
stream routing, not a changed stored field. An adjacent unchanged storage call
does not make those options persistent. The import must belong to the same diff
side, and other visible `Console` uses leave the binding conservative. Explicit
storage changes, other changed fields, and known persistence-owner paths still
retain their warnings.
Changing or removing an existing explicit `statePath` variable declaration retains the compatibility hold. The full-file patch owner pairs identical removed and added declaration lines after trimming indentation, including plain moves across hunks; unmatched removed declarations retain the hold. New captures, unchanged declarations, and reference-only awaits do not acquire a hold from this rule. It does not infer semantic equivalence: parentheses-only or other non-identical declaration rewrites may conservatively retain the prior hold.

An in-memory `statePath` field or read-routing argument does not itself define a
stored format. It needs a known persistence owner or file-I/O evidence in the same semantic diff hunk:
file reads, read/write streams, append/truncate operations, or filesystem-qualified open/read/write calls. Generic browser and in-memory methods cannot establish storage context by themselves; generic handle calls can still count as changes once that context exists. Filesystem qualification is best-effort hunk evidence from known receivers and explicit named, default, namespace, or `promises` imports; it does not resolve arbitrary JavaScript data flow.
This preserves dot or bracket members, awaits, nested path builders, and other
read spellings without parsing JavaScript argument syntax. The association is
conservative: an unrelated state path and source read colocated in that hunk
can still require compatibility review. Evidence from separate hunks cannot combine.
File reads can inspect source or media and need a persistence
owner, explicit stored-state evidence, or JSON decoding in the same diff hunk.
Unrelated hunks cannot combine a file read and decoding into storage evidence.
Explicit serialized-format contracts, disk write APIs (including synchronous
variants), browser/VSCode storage, durable storage, and
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
persisted database columns. A suffix such as `users-schema.ts` is only a domain
hint: missing patches, JSON conversion, and local `table`, `column`, or `index`
variables do not establish storage ownership. Explicit schema directories and
storage owners keep their incomplete-patch warnings. Database API signals and
column changes beside `sqliteTable`, `pgTable`, or `mysqlTable` calls in the same
hunk remain evidence, including optional calls and typed calls. The warning
requests review; it does not prove a persisted contract changed. This classification does not change the separate
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

The reviewer also receives fetched main, the unique merge base, introduced-file
metadata from merge-base to head, base-branch changes, and a separately labeled
base-to-head endpoint comparison. Prompt serialization omits only the `patch` and
`patchComplete` fields of host-selected source records: introduced evidence and
PR pull-file records. Captured patches remain unchanged for deterministic policy
and hydration; the input scanner still scans complete committed patches and blobs
with their provenance. Reviewers read hunks from the checkout using the supplied
immutable bounds. Discussion, review comments, maintainer requests, and issue-only
context remain scanner-visible. Hydrated PR cache preflight uses the same projection
for current and persisted file records while retaining complete discussion evidence.
A file that differs only because main advanced is not
automatically a PR edit. Findings in untouched files remain valid when an
introduced hunk elsewhere causes the failure; risks, labels, scores, and fixups
must use that same ownership boundary.

PR source acquisition fetches complete blobless ancestry and the pinned open-PR
test merge before restricted review. Each pinned commit shares one 120-second
budget across ref/exact-object acquisition and verification, with 60-second
fetch attempts. Moved base and head refs never replace the REST pins. Branch
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
The [source-prompt proof](proof/review-source-prompt/README.md) records native
admission and prompt/source refusal controls for the projection boundary.
OpenClaw Bay is unaffected: no observer fields, routes, or controls change.

Security defaults to `None.` when there are no concerns. Do not spend public
space explaining why an uneventful security pass is uneventful.

Concrete blockers or required work in risk, finding, next-step,
merge-blocking proof guidance, acceptance criteria, and remaining-risk text may
use plain priority prefixes such as `[P0]`, `[P1]`, or `[P2]`. Keep those
prefixes unbolded and attached to plain-language consequences or required
actions. Do not add priority prefixes to non-actions such as `none`, routine
maintainer review, normal CI/status-check follow-up, or audit-only details such
as label justifications, AGENTS.md notes, workflow notes, model metadata,
related people, PR stats, or generic evidence lists.

Full review comments, source links, owner routing, acceptance criteria, and
evidence stay under the collapsed `Agent review details` block so the top-level
PR comment reads like a concise review.

Evidence and owner continuation fields (`repo`, `file`, `sha`, `command`,
`reason`, `commits`, `files`, and `attribution source`) quoted as list items
inside model prose are escaped before storage, so quoted text cannot attach a
file, commit, or command to a real evidence entry or add commits and files to
a related person when the durable report is parsed again.

Finding-shaped headings and `body`, `late`, or `confidence` list fields quoted
inside model prose are escaped before storage. They remain quoted text when
the durable report is parsed again and cannot add findings or replace scores.
Renderer-owned list labels such as `Next rank-up steps:` and `Vision evidence:`
quoted inside the rating summary or vision reason are escaped the same way, so
the published rank-up moves and vision evidence come from the structured
decision rather than from quoted prose.

Automerge and autofix state belongs in the command/status comment and hidden
markers, not in the public review section headings. A clean opted-in PR should
still read as `Codex review: passed.` in the durable review comment.

Issues use `**Next step**` instead of the PR-specific `**Next step before
merge**` heading. Non-PR comments are never repair triggers.
Reproduction requests come from the model's assessment and next action; the
renderer does not invent additional evidence requests from keywords in its prose.

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

## Primary Body and Discussion Coverage

Hosted primary issue and PR bodies and retained discussion comments up to
12,000 UTF-16 units remain intact. This includes inline PR review comments;
the existing 24 discussion-comment and 40 inline-comment windows still apply.
This replaces the former 6,000-unit discussion prefix, which could omit a
contributor's later correction without reporting body coverage.
Longer bodies retain an opening plus at most three source-ordered verbatim
excerpts around proof and trace/output anchors, including inside details.
The sibling `bodyCoverage` records the full-source SHA-256, original length,
end-exclusive UTF-16 ranges, omitted units, and incomplete coverage. The
opening, excerpts, JSON escaping, and coverage metadata share the existing
12,000-unit allocation. Candidate overflow, oversized blocks, and unrecognized
layouts can still omit evidence; anchors are navigation, not proof validation.
Inline-comment cache fingerprints include the full-source hash when coverage
is incomplete, so edits in excerpts or omitted text invalidate prior verdicts.

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
patch content, local body overrides, proof statuses, and mutation gates
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

The visible freshness line adds `(Revision N)` from the second completed PR
review onward, using this lifetime count plus the current review. A first review
and issue comments have no revision suffix; re-syncing the same review keeps
the same revision number.

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
<!-- clawsweeper-verdict:needs-human item=<number> sha=<pull-head-sha> confidence=<confidence> hold=security findings=<count> -->
```

For failed reviews, ambiguous reviews, or PR comments that should stay in human
hands, ClawSweeper emits a human-only verdict:

```html
<!-- clawsweeper-verdict:needs-human item=<number> sha=<pull-head-sha> confidence=<confidence> hold=<hold> findings=<count> -->
```

Every PR `needs-human` verdict has two typed attributes. The repair router
routes on these attributes. It does not read the comment prose.

- `hold` tells why the verdict is human-only: `normalization_failed`,
  `review_identity`, `maintainer_decision`, `review_failed`, `security`,
  `proof`, `not_opted_in` (the review is ready, but the PR has no repair-loop
  label), `blocked`, or `undecided`. `maintainer_decision` and `proof` appear
  only when that hold is the one Before-merge item; otherwise the hold is
  `blocked`. A maintainer can waive `not_opted_in`, `maintainer_decision` and
  `proof`; see [auto-update-prs.md](repair/auto-update-prs.md).
- `findings` is the number of typed review findings. It is `0` for a failed or
  unnormalized review. A value above `0` sends the PR to the repair lane.

A `needs-human` verdict without these attributes stays a human pause.

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

### Reviewer network boundary

Hosted Codex issue/PR review tools use the `clawsweeper-review` permission profile in
`.github/actions/setup-codex/review-permissions.toml`, owned by ClawSweeper
maintainers and verified with Codex 0.162.1. Update this guidance when
the pinned CLI, profile, credential handling, or setup smoke changes. The active profile
extends read-only filesystem access and enables the managed proxy in limited
mode for its explicit GitHub, npm, Node, MDN, and OpenClaw documentation hosts.
Other hosts are blocked; blocked access is not evidence against the PR. The
sandbox receives the target repository's read-only GitHub App token only as
`GH_TOKEN` when the review job supplies it (contents, issues, and pull requests
read; expires within the hour). Use `gh api` or other authenticated GitHub reads
to avoid public rate limits; the token cannot write. Never put it in a URL, log
it, or send it to a non-GitHub host. Without a token, use public endpoints or
pre-fetched GitHub context. Read downloaded screenshots/videos through the media
proof manifest. The allowlist is not a credential containment boundary: a
prompt-injected reviewer could leak the token in a GET query string to an
allowlisted third-party host. Its read-only, single-repository, one-hour scope
limits the impact.

Review setup opts in with `review-network: "true"`; review commands select
`--codex-sandbox clawsweeper-review`, translated to Codex configuration
`default_permissions="clawsweeper-review"`. Neither exec nor the app-server
thread/turn path overrides that profile with a legacy sandbox policy. Setup
fails before publication if allowed HTTPS fails, unlisted HTTPS is not rejected
by the proxy, or a checkout write succeeds. Non-review callers and offline local
reviews keep their existing sandbox settings.

Capability text follows the active `CLAWSWEEPER_RUNNER` before the Codex sandbox
argument. OpenClaw reviews have network access through gateway execution with
sandbox mode off; they do not use the Codex allowlisted proxy, and must treat the
checkout as read-only by instruction. Their final child environment allowlist
strips GitHub tokens, so OpenClaw prompts retain the no-token guidance even when
an inspection token was supplied to the parent. Token capability text accounts
for that runner-specific filter as well as the sanitized Codex environment. Other Codex sandbox
selections retain the no-review-tool-network statement.
This reporting does not change either runner's execution policy.

The required-style `review-network-smoke` CI job runs on every PR using
`ubuntu-24.04`, Node 24, and the Codex version pin read from setup-codex. It installs
into a temporary prefix without secrets, creates an isolated Codex home, applies
the same hosted Linux user-namespace prerequisites, and runs the configuration
writer and enforcement smoke unchanged. Any smoke failure fails the job.
