# Per-PR hydration watermark proof

This receipt proves the review-side hydration snapshot at implementation head
`7fddfc1c2274c1a08ff5862100fc54278904f8ad` in Docker-backed Crabbox
`local-container` lease `cbx_8819da9c9dc2`.

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

The second review found that the persistence-only snapshot was attached to `ItemContext` and would
therefore enter Codex prompt JSON and media URL discovery. The repaired serializers explicitly omit
the snapshot while retaining the compact commit/review-comment windows. Focused sentinels prove a
compact review comment remains visible and the full cached comment is absent from both boundaries.

The final review found that the independent 1 MiB snapshot cap could still push a valid review over
the canonical publication boundary. The repaired report renderer now measures the complete serialized
UTF-8 record against the publication owner's shared 2 MiB constant. If the record is too large, it
replaces only the snapshot front-matter value with `unknown`; the review body remains byte-identical
and the next cycle rehydrates from GitHub. The boundary regression covers both this oversized fallback
and normal-size snapshot retention.

The full `pnpm run check` gate passed 3,413 tests: 3,405 passed, 8 skipped, and 0 failed. The focused
coordinator/context/workflow proof passed 30 of 30 tests. The normalized transcript and stderr were
scanned with TruffleHog 3.96.0: 0 verified and 0 unknown secrets.

The canonical Worker report owns the cache metadata; the Git `clawsweeper-state` branch receives no
new file. OpenClaw Bay is unaffected because the publication limit and observer-facing record schema
are unchanged. This proof does not mutate GitHub, Worker state, lifecycle state, or dashboard data.
