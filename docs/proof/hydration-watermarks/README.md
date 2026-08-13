# Per-PR hydration watermark proof

This receipt proves the review-side hydration snapshot at implementation head
`6a16505700422bd888d4c31605dc79c32cfa3d47` in Docker-backed Crabbox
`local-container` lease `cbx_6bc6e885a1e5`.

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

The full `pnpm run check` gate passed 3,409 tests: 3,401 passed, 8 skipped, and 0 failed. The focused
coordinator/context/workflow proof passed 28 of 28 tests. The normalized transcript and stderr were
scanned with TruffleHog 3.96.0: 0 verified and 0 unknown secrets.

The canonical Worker report owns the cache metadata; the Git `clawsweeper-state` branch receives no
new file. OpenClaw Bay is unaffected. This proof does not mutate GitHub, Worker state, lifecycle state,
or dashboard data.
