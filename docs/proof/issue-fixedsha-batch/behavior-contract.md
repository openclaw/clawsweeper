# Fixed-SHA issue enrichment behavior contract

## Claim

Repeated high-confidence issue decisions with the same `fixed_sha` reuse the fixing pull-request
association already present in the hydrated canonical report without making a GitHub request. Cold
resolutions share one recent-pulls list per repository process, match both `head.sha` and
`merge_commit_sha`, and use `GET /commits/:sha/pulls` only for associations absent from that list.

## Exercised surface

- The production `createStatusContext` resolver used by the review command after Codex returns a
  decision and before the report is rendered.
- The production review workflow handoff of the prior canonical report to that resolver.
- The existing `fixed_sha` and high-confidence `fixed_pr_*` report fields; no new state schema or
  state write is introduced.
- A counting fixture with four repeat resolutions and three cold resolutions: one merge-SHA list
  match, one head-SHA list match, and one commit-pulls fallback.

## Expected observable behavior

- Repeat decisions return the byte-equivalent persisted `FixedPullRequest` tuple and make zero
  GitHub calls.
- Cold list matches retain the existing merged/default-branch/explicit-closing-reference guards and
  the existing `GitHub commit PR lookup` source.
- A fixed SHA not represented by a qualifying recent pull uses the existing per-SHA commit-pulls
  lookup and commit-message fallback.
- The counting fixture changes from 7 `commit_pulls` requests to 1 pulls-list request plus 1
  `commit_pulls` fallback. In general, before is `R + C`; after is `1 + C_unmatched`, with repeats
  contributing zero.
- A changed `fixed_sha` never reuses the prior association.

## State and architecture boundary

The plan job hydrates canonical `records/<repo-slug>/items/<number>.md` records from the Cloudflare
Worker, and `prepare-review-runtime.mjs` copies the selected prior records into each review runtime.
The review report already persists the association as `fixed_pr_*`, so reuse belongs at the review
resolver boundary. The `clawsweeper-state` Git branch no longer owns records and receives no new
cache file; its remaining `jobs/**`, `results/**`, and notification state are untouched.

OpenClaw Bay is unaffected. This changes neither lifecycle publication nor any status, telemetry, or
dashboard data contract.

## Limits

The recent-pulls optimization intentionally inspects the newest 100 pull requests. Older or otherwise
unmatched associations retain the exact per-SHA fallback. The proof uses deterministic GitHub API
fixtures in a Docker-backed Crabbox container; it does not mutate GitHub, publish Worker state, deploy,
or measure production latency.
