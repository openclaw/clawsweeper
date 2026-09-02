# Router throttle resilience red/green

## Red

The loopback contract was added before the production fix and run against the
fresh `origin/main` implementation. The exact-comment path fetched its source
comment, then received GitHub's installation-rate-limit body from the issue
comment-history endpoint:

```text
GitHubRateLimitError: GitHub API rate limited ...
Command failed: gh api repos/openclaw/router-throttle-proof/issues/1/comments?per_page=100 --paginate --slurp
gh: API rate limit exceeded for installation (HTTP 403)
1 !== 0
```

The process exited 1 before writing a router report or a durable command claim.

## Green

The same real loopback HTTP boundary now passes all contract probes:

```json
{
  "throttle_exit_zero": true,
  "abuse_403_exit_zero": true,
  "throttle_429_exit_zero": true,
  "structured_skip": true,
  "routable_data_completed": true,
  "cursor_unchanged": true,
  "cursor_resumed_incrementally": true,
  "real_error_nonzero": true
}
```

The mixed batch classifies the already-fetched command as `ready`, retains the
throttled command as `waiting`, writes the partial report and ledger, and then
emits the structured defer. Recovery reads from the unchanged watermark with
`sort=updated&direction=asc`, filters the id already recorded at that exact
timestamp, and advances only after the successful cycle.

The repository gate `pnpm run check` also passed: static checks, formatting,
builds, lint, changed-surface coverage, and the complete coverage suite.
