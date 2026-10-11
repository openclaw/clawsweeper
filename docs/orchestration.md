# ClawSweeper Orchestration

Read when changing command intake, exact review dispatch, queue capacity,
publication, or apply state.

1. Intake normalizes events and review commands into exact review requests.
2. The durable queue chooses priority and worker capacity.
3. Codex owns read-only review and in-turn proof assessment.
4. Deterministic code owns authorization, repository boundaries, capacity,
   source-freshness checks, and apply mutations.
5. Comments, records, ledgers, and dashboards are projections, not independent
   sources of truth.

## Review execution and publication

Each review starts one Codex process. Codex owns request and stream recovery;
ClawSweeper preserves the final error classification and lets the durable queue
own any fresh review attempt. The app-server worker reports a failed turn with
the turn's own error (`Codex turn failed: <message>`) and an interrupted turn as
`Codex turn interrupted.`; failure diagnostics read an app-server turn error from
its `turn/completed` notification ahead of captured stderr, as they read native
`turn.failed` events.

On POSIX, the shared Codex spawn helper kills remaining group members when the
direct child exits naturally, including descendants holding output pipes open.
Requested termination retains the existing graceful interval and worker-owned
final cleanup, including asynchronous errors after the leader exits. Result
capture still waits for stdio to close. Repeated signals do not interrupt
escalation, and the app-server worker also finishes group cleanup after
completed or failed turns before it exits.

The shared OpenClaw source setup script bounds only its network Codex tag fetch.
Its default deadline is two minutes; the first present setting among
`CLAWSWEEPER_OPENCLAW_CODEX_SOURCE_TIMEOUT_MS`,
`CLAWSWEEPER_GH_COMMAND_TIMEOUT_MS`, and
`CLAWSWEEPER_NETWORK_COMMAND_TIMEOUT_MS` overrides it. Invalid or unsupported
timer values use the default. Both the composite Action and review runtime use
this one fetch owner, which stops Git's process group before returning and leaves
Git low-speed settings untouched. Existing cache, pin validation, and retry
classification remain unchanged.

A batch publisher hydrates only the complete record tuples named by its review
artifacts, reconciles those selected tuples against current GitHub state, then
publishes the records and synchronizes their comments in the same job. It does not download the repository-wide snapshot, pull source Git
history, reconcile unrelated records, or dispatch another comment-sync run.
Scheduled comment synchronization remains a recovery path.
Explicit-item planning uses the same requested item set for focused hydration
and selection. Repository-wide planning still loads the repository snapshot.

## What Should Stay Thin

GitHub workflows should do only setup, credential minting, script execution,
artifact upload, and state publishing. Routing rules belong in TypeScript so
webhook intake, repository-dispatch fallback, manual dispatch, and scheduled
runs use the same behavior.

The activity observer is intentionally lossy and may cancel older in-progress
observer runs. Review, apply, and command-router jobs are not lossy.

## What Must Stay Deterministic

Do not move these checks into model judgment:

- maintainer/write authorization
- target repository allow/deny boundaries
- protected labels and maintainer-authored close guards
- stale item drift and exact-head review identity
- worker-budget enforcement
- final GitHub comments, labels, and closes

Codex proposes a disposition; deterministic code decides whether the resulting
apply mutation is allowed and applies it.
