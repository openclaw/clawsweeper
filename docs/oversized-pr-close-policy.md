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
The threshold defaults to 30,000. It must be a positive integer; invalid values
fall back to the default. Exactly 30,000 lines is admitted; 30,001 is oversized.
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
review-tool setup, reactions, and reservation, then use the same `review` CLI
to write the report. Ordinary admitted PRs reuse the payload during hydration.
Each head or label change is evaluated again. This policy never reopens a PR.

`CLAWSWEEPER_OVERSIZED_PR_CLOSE_ENABLED` gates apply; it defaults off in a
standalone CLI and defaults to `true` in the sweep workflow. The normal
close-reason filter includes this reason when
`CLAWSWEEPER_AUTO_CLOSE_REASONS=all`. Dry-run, comment-only publication, or a
closed policy/reason gate leaves the proposal in `records/<slug>/items/<n>.md`
with `decision: close` and its additions, deletions, changedFiles, threshold,
and head evidence. No scanner or model provenance is asserted.

Apply requires complete recorded metadata and repeats the live PR size,
head, open-state, lock, and exemption checks immediately before closing.
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
