# CSW-093 Workstream 5 proof contract

## Claim

OpenClaw Bay renders a bounded lifecycle Kanban from only the durable
`ExactReviewLifecycleProjection` reducer. Its read path neither changes queue
or Durable Object state nor treats a workflow, worker step, or action result as
a lifecycle fact.

## Exercised surface

- Public Worker route: `GET /api/durable-lifecycle-bay`
- Durable Object route: `GET /lifecycle-bay`
- The built `/bay-demo` page and its lifecycle Kanban renderer

## Controlled scenario

A local Worker/Durable Object fixture records synthetic lifecycle projections
for: pending, acknowledgement pending, completed, superseded, requeued,
dead-letter, target closed/missing, policy/guarded/failure, and acknowledgement
skipped. It includes a re-review sequence where an older revision remains
requeued or superseded while a later revision starts in its own earlier lane.
The fixture also covers malformed, mixed, unavailable, stale, and 513-row
sources, plus a 25+ card complete source to exercise the 24-card round-robin
sample.

## Required observations

- The pure Worker/DO read causes no Durable Object write, schema initialization,
  prune, lease reclaim, alarm scheduling, or GitHub request; a subsequent
  ordinary initialized queue request against that same local DO still succeeds.
- Cards retain the target/revision/fence record cardinality internally and never
  expose a fence, run, claim, delivery, receipt, comment, or digest identifier.
- `Completed` appears only from the lifecycle reducer; acknowledgement-pending
  and acknowledgement-skipped cards do not appear in Completed.
- Incomplete, malformed, mixed, unavailable, stale, or over-cap data renders
  one Unknown state with no partial lane totals or cards. A complete zero-row
  response renders Empty instead.
- Browser screenshots capture Completed, Terminal attention, Unknown, and the
  bounded sample view.

## Command and environment

Run the focused tests and builds plus the generated proof script through
Docker-backed Crabbox local-container on `mcr.microsoft.com/playwright:v1.60.0-noble`,
with `--no-hydrate` and `--timing-json`. Run lint, format, and diff checks as
the final local branch gates. The proof blocks external network access except
the local Worker; it never contacts GitHub, production Worker/DO state, queues,
gates, or R2.

## Artifacts and limits

The proof script writes a redacted runtime transcript, a readable Worker/DO
initialization transcript, machine-readable sequence/summary, response captures,
and screenshots under this directory. It proves the controlled Worker/DO and
browser surface only; it does not claim production data volume, production
freshness, or live Activity behavior.
