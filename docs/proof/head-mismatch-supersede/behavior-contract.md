# Head-mismatch dead-letter supersession behavior contract

## User-visible goal

The exact-review dead-letter operator drains stale publication artifacts only when the operator can prove that the same pull request has a completed canonical review at its current, different head. Head drift by itself never authorizes resolution or replay.

## Target

- Type: operator CLI and HMAC-authenticated queue API.
- Access: `node scripts/exact-review-dead-letter-operator.mjs --action reconcile` against loopback queue and GitHub stubs.
- Fixtures: sanitized dead-letter rows, GitHub pull-request identities, canonical record envelopes, queue pressure, and guarded mutation responses. No production credential or endpoint is used.

## Operator tasks and expected behavior

1. Reconcile a `retry_exhausted` publication whose recorded source head differs from the live pull-request head and whose signed canonical `items/<number>` record identifies the same repository, item number, pull-request type, `review_status: complete`, and live `pull_head_sha`.
   - Resolve the stale row with `resolution_outcome: superseded`.
   - Record an audit note naming the full newer head and exact canonical-record endpoint.
   - Re-read GitHub immediately before resolution and require the same open node identity and head used by the canonical evidence.
   - Do not enqueue or recover a review.
   - Increment the queue publication completed and superseded totals without incrementing published.
2. Reconcile the same mismatch when the canonical record is missing, malformed, incomplete, for another target, failed, or at another head.
   - Leave the row open.
   - Count the target as `head_mismatch_unproven` with the existing bounded sanitized sample shape.
   - Do not call the resolution or recovery mutation.
3. Reconcile more work than one cycle permits.
   - Inspect at most ten head-mismatch targets for supersession.
   - Resolve at most `MAX_RESOLUTION_IDS` (20) rows for one proven target.
   - Leave excess work open with explicit target-cap or partial-row classifications.
4. Run with `execute=false`.
   - Report the same planned superseded target and row counts.
   - Perform no queue mutation.
5. Encounter `tuple_protocol_invalid` or `workflow_cancelled` head-mismatched rows.
   - Leave them open and do not query supersession evidence for an otherwise excluded-only target.

## Anti-cheat probes

- Change the canonical record head away from the live GitHub head; resolution must stop.
- Advance the live pull-request head after canonical evidence is read but before resolution; resolution must stop.
- Remove the canonical record; resolution must stop.
- Cross the ten-target and 20-row boundaries; only the bounded prefix may resolve.
- Repeat the positive fixture without `--execute`; the output may plan resolution but the stub must observe zero mutations.
- Pass a typed superseded outcome without resolution aliases; the Worker must reject it.

## Evidence required

- RED results from fresh `origin/main` showing the new contract failures.
- GREEN loopback results for the complete operator and queue-runtime test files.
- Docker-backed Crabbox `local-container` transcript at the committed implementation head.
- Full `pnpm run check`, clean Codex autoreview, content hashes, secret scan, provider/lease identity, and cleanup state.

## Limits

The loopback fixtures prove the real CLI process and Durable Object route behavior at their HTTP boundaries. They do not mutate the production queue, consume GitHub quota, or prove that a particular production dead letter currently has a matching canonical record. `tuple_protocol_invalid` and `workflow_cancelled` resolution policy remains out of scope.

OpenClaw Bay is unaffected. This change uses existing observer-only queue metrics and the dynamic skip-reason map; it adds no queue, workflow, GitHub, recovery, deploy, or rollback action to Bay.
