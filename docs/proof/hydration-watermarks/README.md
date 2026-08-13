# Per-PR hydration watermark proof

This receipt proves the review-side hydration snapshot at implementation head
`699bda3e5217a3592a639d7a705fecc405dd4dbf` in Docker-backed Crabbox
`local-container` lease `cbx_adf7c25d0c83`.

The deterministic counting fixture models three unchanged and two changed PRs. Legacy hydration is
`2 * (U + K) = 10` commit/review-comment list reads. The candidate makes zero reads for all three
unchanged PRs, one `since` review-comment read for an edited-comment PR, and two full reads for a
changed-head PR: 3 total. Changed hydration windows and complete inputs compare byte-for-byte with
fresh full hydration. A delete-plus-add fixture proves an invisible deletion causes merged ID
cardinality to exceed the live count and falls back to a full read.

The same coordinator passed through the real GitHub CLI transport against public
`openclaw/clawsweeper` PR #97. The endpoint returned its known edited review comment from a historical
`since` query. Three snapshot reuses made no list call; a synthetic metadata change made one live
`since` request; a synthetic changed head made one live commit-list and one live review-comment-list
request. The proof is read-only.

ClawSweeper's first review identified that the initial snapshot retained whole REST objects. The
repaired snapshot now accepts only an exact minimized schema: commit SHA/login/message/author name
and the review-comment fields consumed by filtering, prompt compaction, related-link discovery,
content revision, and the activity cursor. A regression injects unrelated API metadata and proves it
never appears in serialized canonical state. Full comment bodies remain because they are required to
reconstruct byte-identical public review inputs.

The full `pnpm run check` gate passed 3,409 tests: 3,401 passed, 8 skipped, and 0 failed. The focused
coordinator/context/workflow proof passed 28 of 28 tests. The normalized transcript and stderr were
scanned with TruffleHog 3.96.0: 0 verified and 0 unknown secrets.

The canonical Worker report owns the cache metadata; the Git `clawsweeper-state` branch receives no
new file. OpenClaw Bay is unaffected. This proof does not mutate GitHub, Worker state, lifecycle state,
or dashboard data.
