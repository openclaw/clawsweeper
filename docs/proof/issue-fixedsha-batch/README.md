# Fixed-SHA issue enrichment proof

This receipt proves the review-side fixed-SHA resolver at implementation head
`66cb6daba4b3a55d27c86f99abe9351b5c1ea361` in a Docker-backed Crabbox
`local-container` lease.

The counted fixture follows the real review path. Four repeated issue/fixed-SHA pairs carry their
existing high-confidence `fixed_pr_*` state from a prior canonical report. Three pairs are cold: one
matches a recent pull's unique merge SHA, one uses the exact lookup for a shared head SHA, and one is
absent from the recent list and falls back to the per-SHA commit-pulls endpoint. The legacy formula is
`R + C = 4 + 3 = 7` `commit_pulls` requests. The candidate makes one recent-pulls request, two bounded
fallbacks, and zero requests for repeats: `1 + (C - C_merge) = 1 + (3 - 1) = 3` counted requests.

The same request formula also passed through the real GitHub CLI transport against public
`openclaw/clawsweeper` PR #1138 and issue #1135. Four prior-report repeats made no `gh` call, the
real merge SHA used one recent-pulls list, and the real head and interior commit SHAs used two exact
commit-pulls fallbacks; all three resolved PR #1138. The run was read-only.

The full `pnpm run check` gate passed 3,408 tests: 3,400 passed, 8 skipped, and 0 failed. The focused
resolver/policy proof passed 34 of 34 tests. The transcript and stderr were scanned with TruffleHog
3.96.0: 0 verified and 0 unknown secrets.

The first proof attempt reached the full gate but the base `node:24-bookworm` image lacked `jq`, so
36 existing shell-workflow tests failed with `jq: command not found`. The proof harness now installs
that repository test prerequisite. ClawSweeper's first review then found that head SHAs can be shared
by multiple PRs. The repaired resolver now treats an exact `merge_commit_sha` match as authoritative,
because that merge commit belongs to one PR, even when another recent or older PR shares the SHA as
its head. Head-only and absent matches still use the legacy exact endpoint. The refreshed
successful final live-transport run used lease `cbx_06ffbac51895`; Crabbox stopped it automatically. Two
credential/rate-limit attempts stopped before tests, their captures were discarded, and the frozen
harness reran unchanged after quota reset. One unrelated
pre-existing exited local-container lease was left untouched.

This is controlled fixture evidence. It does not mutate GitHub, publish canonical Worker records,
write the operational state repository, deploy, or exercise OpenClaw Bay.
