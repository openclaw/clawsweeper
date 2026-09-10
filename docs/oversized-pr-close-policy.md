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

Known gap: when direct publication is not accepted and the proposal falls back
to the durable queue, the queued lease-expiry write advances PR activity after
the report's observation. The unchanged source-freshness guard keeps the PR
open with `skipped_changed_since_review`; it can be re-evaluated at the next
event or head. Deferred publication is not fixed by carrying the lease tuple.
The follow-up is to create the final metadata proposal under publication
ownership, after the publisher acquires its current lease and fence.

`CLAWSWEEPER_OVERSIZED_PR_CLOSE_ENABLED` gates apply; it defaults off in a
standalone CLI and defaults to `true` in the sweep workflow. The normal
close-reason filter includes this reason when
`CLAWSWEEPER_AUTO_CLOSE_REASONS=all`. Dry-run, comment-only publication, or a
closed policy/reason gate leaves the proposal in `records/<slug>/items/<n>.md`
with `decision: close` and its additions, deletions, changedFiles, threshold,
and head evidence. The report also records a metadata source fingerprint and
comment counts. No scanner or model provenance is asserted.

Apply requires complete recorded metadata and repeats the live PR size,
head, open-state, lock, and exemption checks immediately before closing.
Changed metadata or unreadable live state blocks the close. The source record also carries the observation time taken before the PR metadata
read; initial activity at that second or within the one-second clock margin is
ambiguous and keeps the proposal open. Missing handoff observation times fall
back conservatively to the PR update timestamp. Submitted reviews expose no
edit timestamp, so a PR update timestamp in that observation window also blocks
initial receipt creation when reviews exist. Before comment
publication, apply captures bounded issue-comment, timeline, inline-comment,
and review metadata, with a maximum of three 100-entry pages per stream.
Incomplete reads keep the proposal open. The receipt excludes only the exact
owned review-comment ID and verifies that comment against its write response;
all other activity remains fingerprinted. The baseline is persisted before
publication, and the exact owned write identity is persisted before any
post-publication read, including when subsequent validation fails. Forced checks before closing catch
body edits and same-second human comments after publication, and persisted
receipts preserve that protection across retries. PR files, commits, blobs,
scanner work, and model review are not hydrated by this guard.

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
`node scripts/proof-oversized-pr-close-effects.mjs` drives the built CLI through
a loopback HTTP GitHub adapter and inspects service state plus items/closed
records for first/existing durable review reservation and closing, protected-label refusal, and late exemption, body,
and human-comment changes. This uses synthetic data and transport; it does not
close a live GitHub PR. The workflow test also executes a HTTP-409 finalization
branch and verifies that supersession prevents publication.
