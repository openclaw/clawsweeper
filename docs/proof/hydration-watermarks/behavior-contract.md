# Per-PR hydration watermark behavior contract

## Claim

Review hydration persists a bounded snapshot of the PR commit window and complete review-comment
inputs in the canonical report. When PR `updated_at`, head SHA, commit count, and review-comment count
still match, the next review reuses both snapshots with zero commit-list or review-comment-list calls.
Changed PRs preserve the same hydrated inputs by using an edited/new review-comment `since` delta
when safe and full list reads when force-pushes or invisible deletions require them.

## Exercised surface

- The production `hydratePrLists` coordinator called by `collectItemContext` after the already-required
  PR detail fetch and before prompt compaction, semantic revisions, related-item discovery, or activity
  cursor creation.
- Canonical report persistence through the single-line `pr_hydration_snapshot` front-matter field.
- Durable data minimization: snapshots reject unknown keys and retain only commit SHA, author login,
  message/author name, and the review-comment fields consumed by prompt compaction, related-link
  discovery, filtering, content revision, and the activity cursor. Unrelated REST metadata is removed.
- Planning/runtime ownership: the open-item inventory already carries `updated_at`; it does not carry
  head SHA. The existing structural probe or PR detail fetch supplies the exact head without adding a
  request.
- Deterministic unchanged, edited, force-pushed, and delete-plus-replacement fixtures.
- A read-only real GitHub CLI fixture using public `openclaw/clawsweeper` PR #97.

## Expected observable behavior

- Three unchanged snapshots make zero commit-list and review-comment-list reads.
- A metadata/comment edit with an unchanged head reuses commits and makes one `since` review-comment
  read; its merged hydration bytes equal a fresh full hydration.
- A force-push head change performs one full commit-window read and one full review-comment-window
  read; its hydration bytes equal a fresh full hydration.
- A delete-plus-replacement delta cannot hide the deletion: merged ID cardinality exceeds the live
  `review_comments` count, so hydration discards the delta result and performs a full read.
- The counting fixture uses `U=3` and `K=2`: before is `2 * (U + K) = 10` list reads; after is three
  reads for the two changed PRs and zero for unchanged PRs.
- Snapshot JSON larger than 1 MiB is not persisted, leaving at least half of the 2 MiB canonical-record
  limit for the review report and making the next cycle rehydrate normally.
- Unknown nested fields in persisted snapshots are rejected, and source REST fields outside the
  explicit review-input schema never enter the canonical report.

## GitHub `since` and deletion finding

The live endpoint for PR #97 returns edited review comment `3255775240` when queried with
`since=2026-05-18T00:38:30Z`, one second before that comment's `updated_at`. The REST collection returns
current comments and has no deletion tombstone. The implementation therefore trusts a delta only when
merging its IDs into the persisted complete snapshot produces exactly the current PR
`review_comments` count; count decreases and delete-plus-add replacements both force a full read.

Commit-list cursoring is not safe for changed heads: the REST commit list exposes no stable
append-only cursor, and both ordinary new commits and force-pushes change the head. Changed heads use a
full commit-window read.

## State and architecture boundary

Canonical review records are owned by the Cloudflare Worker and hydrated into each review runtime.
The Git `clawsweeper-state` branch does not own records and receives no new file. Existing decision,
comment, label, apply, and action-ledger writes are unchanged; the report gains cache-only hydration
metadata.

OpenClaw Bay is unaffected. This changes review input hydration only and adds no lifecycle, status,
telemetry, or dashboard contract.

## Limits

The live proof is read-only and depends on public PR #97 retaining its current review-comment history.
It does not edit/delete a GitHub comment, mutate Worker state, deploy, or claim latency improvements.
