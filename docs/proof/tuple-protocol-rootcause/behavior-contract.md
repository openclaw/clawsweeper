# Tuple-protocol dead-letter behavior contract

## User-visible goal

A successfully reviewed exact item must not dead-letter merely because a later publication attempt refreshes apply-only record metadata after the canonical tuple was already accepted. Stale tuple-protocol rows may be retired only when a completed canonical review proves that a newer pull-request head replaced them; current-head rows stay recoverable.

## Target

- Type: HMAC-authenticated publication API and exact-review dead-letter operator CLI.
- Access: loopback Worker/Durable Object requests plus `node scripts/exact-review-dead-letter-operator.mjs --action reconcile` against loopback queue and GitHub fixtures.
- Fixtures: protocol-v2 publication decisions, accepted canonical receipts, apply-metadata byte drift, sanitized dead-letter rows, GitHub pull-request identities, and canonical record envelopes. No production credential or endpoint is used.

## Operator tasks and expected behavior

1. Retry a batch-owned publication after its canonical tuple was accepted, using the same target, fence, and revision but refreshed tuple bytes.
   - Return HTTP 202 with `deduped: true` and the first accepted canonical receipt.
   - Preserve the first accepted canonical content.
   - Let the batch resume lifecycle post-effects instead of classifying the retry as `tuple_protocol_invalid`.
2. Send conflicting tuple bytes through the non-batch direct-publication endpoint.
   - Keep the strict conflict guard and return HTTP 400 with `invalid_direct_publication_plan: conflicting direct publication retry`.
3. Reconcile a `tuple_protocol_invalid` row whose recorded source head differs from the live pull-request head and whose signed canonical record proves a completed review at that live head.
   - Resolve it as `superseded` through the existing six-way evidence gate, revalidation, target cap, and row cap.
   - Keep `workflow_cancelled` excluded.
4. Reconcile a `tuple_protocol_invalid` row whose recorded source head is still current.
   - Do not supersede it.
   - Recover it through the existing fresh-review path when pressure and capacity permit.

## Anti-cheat probes

- Change the retry target or remove active batch ownership; publication must remain blocked.
- Use the direct endpoint instead of the batch endpoint; conflicting bytes must remain rejected.
- Remove or alter newer-head canonical evidence; supersession must stop.
- Keep the dead-letter source head equal to the live head; supersession must not run and recovery must remain eligible.
- Pair a proven tuple row with a `workflow_cancelled` row; only the tuple row may resolve.

## Evidence required

- RED failures from fresh `origin/main` for batch retry drift and tuple-row supersession.
- GREEN loopback API and operator results.
- Full `pnpm run check` and clean Codex autoreview.
- Docker-backed Crabbox `local-container` receipt at the final committed head, including provider, image, lease, transcript hashes, and cleanup.

## Out of scope

The loopback proof does not mutate the production queue or claim that every historical row has newer-head evidence. It does not weaken non-batch conflict detection or resolve `workflow_cancelled` rows.

OpenClaw Bay is unaffected: this changes queue-owned publication replay and operator policy while adding no observer action surface.
