# CSW-127 Phase 0.5 behavior proof contract

## Claim

Under GitHub installation throttling, exact-review command intake and automatic
review/apply maintenance preserve durable work and defer retryable operations to
an authoritative credential-pool reset when one is available. Expected quota
pressure must not strand command work, leave claims indefinitely dispatching,
or turn read-only/opportunistic maintenance into an avoidable workflow failure.
Operators must be able to distinguish rate-limit deferral, cancellation, and a
genuine claim stall from the public status/telemetry surfaces without exposing
raw identifiers or secrets.

## Exercised surface

- GitHub rate-limit classification and reset provenance by credential pool.
- Durable command intake and retry/backoff transitions.
- Exact-review dispatch-to-claim recovery after throttling or cancellation.
- Automatic read-only proof/reconciliation workflow exit behavior.
- Queue/status reason fields consumed by operators and OpenClaw Bay.

## Scenarios and fixtures

1. A target-app request returns HTTP 403 with a credible
   `X-RateLimit-Reset`; the durable command remains recoverable and the retry is
   deferred to that reset plus bounded jitter.
2. The same request has no credible reset header; the existing bounded fallback
   remains explicit and non-authoritative.
3. A read-only/opportunistic maintenance request is throttled; the workflow
   records a structured deferral/skip instead of hiding a real error or running
   a write stage.
4. An exact-review run is cancelled before claim or loses its handoff; the queue
   exposes the cancellation/stall reason and can recover the durable member
   idempotently without fabricating a completed review.
5. A non-throttle 403, malformed reset, persistent 5xx, or privacy-boundary
   violation remains a hard failure.

Fixtures will use a loopback GitHub API plus a real local Worker/Durable Object
instance in Docker-backed Crabbox. No live GitHub workflow, queue, DLQ, gate,
credential, deployment, or production state will be mutated for proof.

## Commands and environment

- Focused Node 24 tests for the changed retry, command-intake, workflow, and
  queue/status contracts.
- `pnpm run build:all`, relevant lint/format checks, and `pnpm run check`.
- Docker-backed Crabbox `local-container` using the repository proof script and
  a pinned Node/Playwright image appropriate to the exercised Worker surface.
- Dirty-patch Codex review before commit and committed-range Codex review against
  `origin/main` before push/PR creation.

## Observable result

- The authoritative reset and credential pool survive the error boundary and
  are used for durable retry timing.
- Retryable command/review work remains durable and is recovered exactly once.
- Opportunistic throttling has an explicit structured outcome; non-throttle
  failures still fail.
- Queue/status output names cancellation or claim-stall causes and contains no
  raw repository/item identifiers, command bodies, request IDs, or credentials.
- OpenClaw Bay renders the bounded recovery-reason count from the same local
  Worker/Durable Object snapshot without exposing private identifiers.
- No write/apply stage runs in any throttled proof scenario.

## Artifact or trace

The executed proof package will be committed under this directory with the
current head, provider/image/run identity, red/green transcript, sanitized
container transcript, redacted Bay screenshot, and secret scan. The PR body
will carry the same current proof summary and exact commands.

## Limits

- Loopback GitHub cannot prove GitHub's external scheduling behavior or account
  quota replenishment; it proves ClawSweeper's handling of the real response
  contract and durable state transitions.
- Live queue recovery will be observed read-only only; no production dispatch,
  rerun, cancellation, DLQ operation, or rollback is authorized by this proof.
- OpenClaw Bay is observer-only. If the public status schema changes, Bay impact
  and rendering proof are required; otherwise the PR must record why Bay is
  unaffected.
