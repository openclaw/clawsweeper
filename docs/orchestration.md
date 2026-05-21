# ClawSweeper Orchestration

Read when changing command intake, repair job creation, workflow dispatch,
worker-capacity routing, automerge, issue implementation, or generated repair
state.

ClawSweeper should stay simple at the orchestration boundary:

1. Intake normalizes events and commands into a job or exact review request.
2. The scheduler chooses priority and worker capacity.
3. Codex owns review, repair, rebase, CI diagnosis, and narrow implementation.
4. Deterministic code owns auth, repo boundaries, worker caps, exact-head merge
   safety, and GitHub mutations.
5. Comments, records, ledgers, and dashboards are generated status surfaces,
   not independent sources of truth.

## Canonical Job Intent

Repair jobs carry `job_intent` in frontmatter. This is the durable routing
contract shared by comment commands, automerge, issue implementation,
commit-finding repair, manual repair jobs, and low-signal cleanup.

Current intents:

- `repair_cluster`: ordinary manually or scheduler-created repair work
- `automerge_pr`: maintainer-approved PR repair/automerge loop
- `implement_issue`: ClawSweeper-generated issue implementation PR lane
- `commit_finding`: repair job created from a ClawSweeper commit finding
- `low_signal_pr_cleanup`: narrow stale/low-signal PR cleanup

Older `source` values remain for compatibility, but new code should make
decisions from `job_intent` first and only fall back to `source` for legacy
jobs. Unknown intents fail job validation.

## Worker Lanes

`job_intent` maps to worker capacity:

- `automerge_pr` -> `automerge_repair`
- `implement_issue` -> `issue_implementation`
- all other repair jobs -> `repair`

`repair:dispatch` derives the default live-worker cap from the job intent when
the caller does not pass `--max-live-workers` or set
`CLAWSWEEPER_MAX_LIVE_WORKERS`. Workflows may still pass an explicit cap when
they intentionally want a narrower lane.

## What Should Stay Thin

GitHub workflows should do only setup, credential minting, script execution,
artifact upload, and state publishing. Routing rules belong in TypeScript so
webhook intake, repository-dispatch fallback, manual dispatch, and scheduled
runs use the same behavior.

The activity observer is intentionally lossy and may cancel older in-progress
observer runs. Review, repair, automerge, apply, and command-router jobs are
not lossy.

## What Must Stay Deterministic

Do not move these checks into model judgment:

- maintainer/write authorization
- target repository allow/deny boundaries
- protected labels and maintainer-authored close guards
- stale item drift and exact-head merge checks
- worker-budget enforcement
- final GitHub comments, labels, closes, pushes, and merges
- no direct local edits to foreign PRs by a human operator

Codex can decide what code needs to change; deterministic code decides whether
the resulting mutation is allowed and applies it.
