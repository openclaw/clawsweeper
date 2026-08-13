# Fixed-SHA issue enrichment proof

This receipt proves the review-side fixed-SHA resolver at implementation head
`553def3061320c864251c6abf7288eb9ba14a905` in a Docker-backed Crabbox
`local-container` lease.

The counted fixture follows the real review path. Four repeated issue/fixed-SHA pairs carry their
existing high-confidence `fixed_pr_*` state from a prior canonical report. Three pairs are cold: one
matches a recent pull's unique merge SHA, one uses the exact lookup for a shared head SHA, and one is
absent from the recent list and falls back to the per-SHA commit-pulls endpoint. The legacy formula is
`R + C = 4 + 3 = 7` `commit_pulls` requests. The candidate makes one recent-pulls request, two bounded
fallbacks, and zero requests for repeats: `1 + C_unmatched = 3` counted requests.

The full `pnpm run check` gate passed 3,407 tests: 3,399 passed, 8 skipped, and 0 failed. The focused
resolver/policy proof passed 33 of 33 tests. The transcript and stderr were scanned with TruffleHog
3.96.0: 0 verified and 0 unknown secrets.

The first proof attempt reached the full gate but the base `node:24-bookworm` image lacked `jq`, so
36 existing shell-workflow tests failed with `jq: command not found`. The proof harness now installs
that repository test prerequisite. ClawSweeper's first review then found that head SHAs can be shared
by multiple PRs, so the repaired resolver reserves the list fast path for one unambiguous merge-SHA
match and sends head-only or ambiguous matches through the legacy exact endpoint. The refreshed
successful run used lease `cbx_0d8a7af39abe`; Crabbox stopped it automatically. One unrelated
pre-existing exited local-container lease was left untouched.

This is controlled fixture evidence. It does not mutate GitHub, publish canonical Worker records,
write the operational state repository, deploy, or exercise OpenClaw Bay.
