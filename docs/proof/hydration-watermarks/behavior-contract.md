# Per-PR hydration watermark behavior contract

## Claim

Review hydration persists a bounded snapshot of the PR commit window and complete review-comment
inputs in the canonical report. When PR `updated_at`, head SHA, commit count, review-comment count, and
a freshly planned inline-comment activity revision still match, hydration revalidates that revision
immediately before consuming the cached comments. Only a just-in-time match reuses both snapshots,
with zero commit-list or review-comment-list calls.
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
- Persistence-only isolation: the full snapshot is excluded from both Codex prompt JSON and media URL
  discovery. Only the existing compact commit/review-comment windows cross the model boundary.
- Final-record budgeting: the fully serialized canonical markdown is measured against the same 2 MiB
  constant enforced by direct publication, with an oversized snapshot omitted before persistence.
- Planning/runtime ownership: the open-item inventory already carries `updated_at`; it does not carry
  head SHA. The existing structural probe or PR detail fetch supplies the exact head without adding a
  request. Planning makes one aliased GraphQL request for up to 100 selected PRs and passes the
  resulting revisions through the shard matrix. Larger plans use `ceil(P / 100)` bounded requests.
- Consumption-time ownership: `hydratePrLists` treats the planned revision as a cheap first filter.
  Only when all snapshot watermarks would otherwise hit does it make one GraphQL revision check for
  that PR. A match permits reuse; a mismatch or check failure takes the normal rehydration path.
- Fail-closed revision coverage: planning and hydration share the same query and decoder. The revision
  hashes review count, thread count and IDs, every fetched
  inline-comment ID and `updatedAt`, and each thread's comment count. A connection beyond 40 threads
  or 40 comments per thread, a missing node, or any GraphQL error yields no revision and therefore
  normal hydration rather than cache reuse.
- Deterministic unchanged, edited, force-pushed, and delete-plus-replacement fixtures.
- A read-only real GitHub CLI fixture using public `openclaw/clawsweeper` PR #97.

## Expected observable behavior

- Three unchanged snapshots make exactly three hydration-time GraphQL revision checks and zero
  commit-list and review-comment-list reads.
- An inline-comment edit after planning validation but before hydration is detected by the one
  just-in-time check and rehydrated. A hydration-time check error also rehydrates and publishes no
  trusted replacement snapshot.
- A comment edit with unchanged parent PR `updated_at` and head reuses commits and makes one `since` review-comment
  read; its merged hydration bytes equal a fresh full hydration.
- A force-push head change performs one full commit-window read and one full review-comment-window
  read; its hydration bytes equal a fresh full hydration.
- A delete-plus-replacement delta cannot hide the deletion: merged ID cardinality exceeds the live
  `review_comments` count, so hydration discards the delta result and performs a full read.
- For `P` planned PRs, `C` planning-approved cache-hit candidates, and `K` PRs that ultimately need
  list hydration, before is `2 * P` list reads. After is `G(P) + C + L(K)`, where
  `G(P)=ceil(P/100)` is planning validation, `C` is the one per-candidate hydration check, and
  `L(K) <= 2 * K` is normal list hydration. The fixture has `P=5`, `C=3`, and `L(K)=3`: 10 reads
  before versus `1 + 3 + 3 = 7` total requests after.
- Snapshot JSON larger than 1 MiB is not persisted. Independently, if an otherwise valid snapshot
  would make the fully serialized UTF-8 canonical record exceed 2 MiB, only that snapshot is omitted
  and the next cycle rehydrates normally.
- Oversized-record fallback preserves the review body byte-for-byte; a normal-size record retains its
  snapshot byte-for-byte.
- Unknown nested fields in persisted snapshots are rejected, and source REST fields outside the
  explicit review-input schema never enter the canonical report.
- The persistence-only snapshot field never appears in the review prompt or media-proof URL scan.

## GitHub `since` and deletion finding

A controlled inline-comment probe on PR #1153 measured the chosen GraphQL fields directly. ADD moved
`reviews.totalCount` and `reviewThreads.totalCount` from 0 to 1 and introduced the thread/comment
IDs plus comment `updatedAt=2026-08-13T06:08:04Z`. EDIT moved the comment timestamp to
`2026-08-13T06:08:22Z` while the parent PR remained `updatedAt=2026-08-13T06:08:04Z`. DELETE left
that parent timestamp unchanged while both counts returned to 0 and the thread/comment tuples
disappeared. The temporary probe comment was deleted; its REST endpoint returned 404 afterward.

These observations are why the revision includes all fetched comment IDs/timestamps rather than only
the newest comment: editing an older inline comment must also move the hash. Per-thread counts catch
reply add/delete, while overall thread and review counts catch initial-comment add/delete.

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

OpenClaw Bay is unaffected. The shared limit keeps existing publication behavior aligned without
changing lifecycle, status, telemetry, or the observer-only dashboard contract.

## Limits

The final container proof is read-only and depends on public PR #97 retaining its current
review-comment history. The separate field-choice experiment briefly added, edited, and deleted one
clearly labeled probe on PR #1153; the probe was removed before implementation work continued. No
Worker state was mutated, nothing was deployed, and no latency improvement is claimed.
