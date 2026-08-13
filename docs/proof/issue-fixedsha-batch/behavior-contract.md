# Fixed-SHA issue enrichment behavior contract

## Claim

Repeated high-confidence issue decisions with the same `fixed_sha` reuse the fixing pull-request
association already present in the hydrated canonical report without making a GitHub request. Cold
resolutions share one recent-pulls list per repository process, resolve unique merge-SHA
associations from that list, and use `GET /commits/:sha/pulls` for head-only or absent associations.

## Exercised surface

- The production `createStatusContext` resolver used by the review command after Codex returns a
  decision and before the report is rendered.
- The production review workflow handoff of the prior canonical report to that resolver.
- The existing `fixed_sha` and high-confidence `fixed_pr_*` report fields; no new state schema or
  state write is introduced.
- A counting fixture with four repeat resolutions and three cold resolutions: one merge-SHA list
  match, one shared-head-SHA exact lookup, and one absent-SHA exact lookup.

## Expected observable behavior

- Repeat decisions return the byte-equivalent persisted `FixedPullRequest` tuple and make zero
  GitHub calls.
- Cold list matches retain the existing merged/default-branch/explicit-closing-reference guards and
  the existing `GitHub commit PR lookup` source.
- A fixed SHA represented only as a PR head uses the exact per-SHA association set, preserving the
  legacy newest-merged selection when multiple PRs share that head.
- A fixed SHA absent from the recent list uses the existing per-SHA commit-pulls lookup and
  commit-message fallback.
- The counting fixture changes from 7 `commit_pulls` requests to 1 pulls-list request plus 2
  `commit_pulls` fallbacks. In general, before is `R + C`; after is `1 + C_unmatched`, where
  head-only associations count as unmatched for safe batching and repeats contribute zero.
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

The recent-pulls optimization intentionally inspects the newest 100 pull requests. Head-only, older,
or otherwise unmatched associations retain the exact per-SHA fallback. The proof uses deterministic
GitHub API fixtures in a Docker-backed Crabbox container; it does not mutate GitHub, publish Worker
state, deploy, or measure production latency.
