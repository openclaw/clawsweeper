# Oversized PR close policy

- Status: active
- Owner: ClawSweeper maintainers
- Source of truth: `src/clawsweeper-oversized-pr-policy.ts`, the review admission
  hook, the guarded apply writer, and `.github/workflows/sweep.yml`
- Verified scope: shared review admission, exact-event handoff, and synthetic
  GitHub apply on the policy branch; production closing is not exercised
- Update when: admission order, metadata fields, exemptions, close gates,
  repository apply rules, or record publication changes

An open pull request whose GitHub-reported additions plus deletions exceeds
`CLAWSWEEPER_MAX_PR_CHANGED_LINES` receives the deterministic
`oversized_pull_request` close proposal before structural-cache inspection,
review-start comments, list/blob hydration, scanning, or model review.
The threshold defaults to 50,000. It must be a positive integer; invalid values
fall back to the default. Exactly 50,000 lines is admitted; 50,001 is oversized.
Missing or invalid size/head metadata admits the PR normally.

Drafts and owner/member-authored PRs are subject to the policy. The existing
`PR_AUTO_CLOSE_EXEMPT_LABEL_NAMES` labels (`clawsweeper:human-review`,
`clawsweeper:manual-only`, `clawsweeper:autofix`, `clawsweeper:automerge`) and
`size: accepted-large` exempt a deliberately large change. PR status label
synchronization creates the maintainer-owned size label but never applies it
on a maintainer's behalf. Existing security/protected-label and repository
apply restrictions remain in force; the `maintainer` label alone does not
exempt an oversized PR.

Exact events, scheduled work admitted through the exact queue, and shard
review share the predicate. The exact-event live-state check saves its raw PR
payload and invokes the built predicate. Oversized items skip target checkout,
review-tool setup and reactions, but reserve the same durable review lease as
ordinary admitted items. Held or throttled reservations defer; superseded queue
authority blocks publication. After reservation/status writes, the workflow
waits through the timestamp margin and refreshes PR metadata, rechecking the
admitted head and size policy. Changed eligibility or head defers to fresh
admission instead of publishing a stale snapshot. The `review` CLI carries the supplied lease owner
and comment ID into the metadata-only report without Git, GitHub, or model calls.
Direct exact publication uses the shared fenced apply path to update the durable comment with
the proposal and, when all close gates pass, the close notice. First reviews
create the durable proposal through that writer; existing reviews update the
canonical comment. Both carry the reserved lease identity. Ordinary admitted PRs reuse the payload during hydration.
Each head or label change is evaluated again. This policy never reopens a PR.

## Queue-owned evidence and publication

Before acknowledgement effects on an oversized PR, the queue captures PR metadata
and the four bounded activity streams: issue comments, timeline, inline comments,
and submitted reviews. Each stream retains the existing three-page, 300-entry
refusal boundary. Missing pages, repeated identities, undatable activity, changing
counts/metadata, and activity inside the observation-second margin invalidate the
evidence. Settled acknowledgements already present are part of the baseline.
Capture adds metadata reads only; it never fetches PR files, commits, or blobs.

The Durable Object stores the baseline in separate bounded keys and journals each
owned acknowledgement POST, PATCH, and DELETE, including duplicate cleanup. Each
write has a persisted intent before its request and a receipt with the comment ID,
kind, before/after body and identity fingerprints, comment timestamps, and the
resulting PR timestamp/count from the post-write observation. An uncertain
response, malformed post-write snapshot, or incomplete receipt prevents closing. Receipt history is retained independently of queue-item
completion; no existing queue-storage migration is required.

The decision allowlist carries a validated, item-bound version-1 reference to that
journal. Capability-aware claims establish an explicit per-item acknowledgement
fence. The fence lasts through publication/apply completion or lease release and
has a deadline bounded by the execution lease and 30 minutes. Heartbeats can renew
a current owner's deadline; a crashed owner cannot block acknowledgements forever.
Queue convergence defers while fenced. As in the existing metadata-only workflow,
queue intake omits the review eyes reaction for oversized proposals; ordinary
reviews retain it. The Worker's fast PR acknowledgement and
its delayed cleanup also use this owner; deferred cleanup is retained for retry.

The upgraded workflow/CLI records reservation, command/review status, durable
comment, mutation-lease, and queued-expiry writes in the same journal. The original
artifact carries the reference, so queued publication can fetch receipts added
after artifact creation without replacing the baseline. Publication owns the
current claim before finalization. It waits a bounded interval for its recorded
writes to appear in PR metadata, replays exact preimages and write responses,
compares all non-owned activity against the original baseline, and repeats the
size/head/exemption and existing canonical-comment checks before closing. A
same-second human review edit remains a fingerprint change even when an owned
write has the same PR timestamp. Missing, malformed, stale, ambiguous, or
incomplete evidence keeps the PR open; ordinary comment delivery and completion
continue subject to their existing authority and canonical-comment guards.

If the journal is unavailable, the consumer writes a durable local failure marker
before continuing ordinary comment effects. That marker prevents its close and is
sealed into the queue at completion. A successor also refuses if a prior owner
never sealed its writes, so a crash cannot lose the failure evidence between
publication attempts. Oversized references use the existing single-item queued
publisher to preserve this per-item fence; ordinary review publication batching
is unchanged.

## Rollout and legacy exception

The maintainer explicitly accepted a bounded legacy exception on September 9,
2026: already-running pre-capability workflow/apply consumers started from the
previous main head before deployment finish under their existing safeguards.
They may close eligible oversized PRs under that existing guard profile. This is
an explicit transition exception, not retroactive evidence enforcement. Do not
invalidate or reopen their work, pause the sweep, or drain those runs.

Every upgraded consumer requires valid queue-owned evidence to close. Against an
older Worker, the new workflow receives no evidence capability and retains the
proposal with a normal kept-open result. The new Worker preserves old claim,
heartbeat, publication, and completion contracts. New workflows advertise the
capability when claiming; their close path cannot silently fall back to legacy
freshness behavior. The coordinator must verify the serving deployment SHA and
the end of the pre-capability cohort after deployment. Bay continues to observe
the existing proposal/close lifecycle and gains no mutation controls.

`CLAWSWEEPER_OVERSIZED_PR_CLOSE_ENABLED` gates apply; it defaults off in a
standalone CLI and defaults to `true` in the sweep workflow. The normal
close-reason filter includes this reason when
`CLAWSWEEPER_AUTO_CLOSE_REASONS=all`. Dry-run, comment-only publication, or a
closed policy/reason gate leaves the proposal in `records/<slug>/items/<n>.md`
with `decision: close` and its additions, deletions, changedFiles, threshold,
and head evidence. The report also records a metadata source fingerprint and
comment counts. No scanner or model provenance is asserted.

Apply requires complete recorded size/head metadata and repeats the live PR
open-state, lock, size, head, and exemption checks immediately before closing.
The queue baseline includes review bodies because submitted reviews do not expose
an edit timestamp. Only individually receipted comment writes can change the
expected comment images; all other stream entries stay fingerprinted. The queue
fence and evidence are checked again after the final bounded activity capture.

Changed metadata or unreadable live state blocks the close. The public notice
uses proposal wording until GitHub confirms the close, so an aborted close never
claims success. After closing, apply updates that same comment to the template
below without replacing a newer canonical review. Normal freshness and
durable-comment guards still apply. The existing writer posts the one
policy comment and closes the PR; `archiveClosed` moves the report to
`closed/` only after success. Bay's observer projection treats the pending
proposal and actual close exactly as other reasons; it gains no action controls.

The public comment is:

> ClawSweeper closed this pull request because it changes {total} lines
> ({additions} added, {deletions} removed) across {files} files, above this
> repository's {threshold}-line limit for review. Changes this large cannot be
> reviewed safely or scanned within limits and usually indicate a stale branch
> merged against an old base. Please open a fresh pull request from current
> `main` containing only the intended change, or split it into focused pull
> requests. A maintainer can apply `size: accepted-large` to exempt a deliberately
> large change.

## Reproducible proof

`node scripts/proof-oversized-pr-close.mjs` exercises metadata admission and
dry-run retention, with a 49,999-line control.
`node scripts/proof-oversized-pr-close-effects.mjs` runs the built CLI through a
loopback GitHub service and the queue receipt store/acknowledgement writer. It
covers first/existing durable comments on direct/queued publication, one-second
POST/PATCH/DELETE metadata propagation, same-second review edits, human comments,
labels/heads, and missing/malformed/stale evidence. Metadata reads are counted
separately and file/blob hydration, scanner, and model work remain zero. Dashboard
tests exercise claim/evidence/receipt/completion routes and old-consumer protocol
compatibility. These use synthetic data and do not close a live GitHub PR.
