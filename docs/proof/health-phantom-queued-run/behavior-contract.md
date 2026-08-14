# Phantom queued-run health behavior contract

## User-visible goal

Operational health must never report a queued workflow run that the live GitHub
census cannot confirm, and one status refresh must perform only a fixed small
batch of exact-run checks. When workflow-run webhook subscriptions are missing,
the health result must preserve the pre-read-model live-poll behavior.

## Target

- Type: loopback `/api/status` API served by the dashboard Worker.
- Access: `wrangler dev --local` with a loopback GitHub fixture and Durable
  Object-backed workflow snapshot.
- Fixtures: one stale snapshot-only queued run, completed and absent live-census
  responses, one genuinely queued live run, and 205 stale queued rows ordered
  by age. No production credential or endpoint is used.

## Operator tasks and expected behavior

1. Read `/api/status` after a queued snapshot entry outlives its freshness TTL
   and the live census reports that run completed.
   - Health is healthy, `queued_over_threshold` is zero, and the stale entry is
     evicted.
   - Worker telemetry identifies the stale workflow run and completed verdict.
2. Read `/api/status` when the stale snapshot run is absent from the live
   census.
   - Health is healthy, `queued_over_threshold` is zero, and the stale entry is
     evicted.
   - Worker telemetry identifies the stale workflow run and absent verdict.
3. Read `/api/status` when the live census still confirms an over-threshold
   queued run.
   - Health remains degraded and counts the genuine queued run.
4. Repeat the phantom scenario without workflow-run/job webhook subscription
   coverage.
   - The health result equals the live census, matching the polling behavior
     that preceded the webhook read model.
5. Read `/api/status` with 205 stale queued rows in the read model.
   - The first refresh issues exactly the fixed batch size of exact-run reads,
     prioritizing the oldest rows, and returns promptly.
   - Unconfirmed rows omitted from that batch do not contribute to
     `queued_over_threshold`; health is unknown until every omitted row has
     either been confirmed or healed.
   - Batch telemetry records the selected batch size and omitted-row count.
   - Repeated refreshes select the next-oldest rows and drain the backlog.

## Anti-cheat probes

- Keep the same snapshot entry but change the live fixture from completed or
  absent to queued; the alert must return.
- Age the queued row past the 24-hour zombie boundary; it remains separately
  observable but must not spend an exact verification request.
- Repeat the phantom request after eviction; the stale entry must not reappear.
- Use an entry within the freshness TTL; the fixture must not claim stale-entry
  re-verification behavior.
- Repeat the 205-row request until the read model is empty; no refresh may
  exceed the fixed exact-read batch, and every row must be selected once.

## Evidence required

- A RED run against fresh `origin/main` showing the phantom degrades health.
- A GREEN run at the final committed head showing completed and absent entries
  heal with telemetry while a genuinely queued run still alerts.
- A final-head Wrangler Worker trace through signed loopback HTTP transport and
  its real SQLite Durable Object.
- `pnpm run check`, including `check:dashboard-strict`, and clean Codex
  autoreview.
- Docker-backed Crabbox `local-container` receipt for the exact final pushed
  head, including provider, image, lease, artifact hashes, and cleanup.
- Programmatic SHA capture plus `git cat-file` cross-check for every recorded
  source/proof object.

## Out of scope

No production workflow, queue, GitHub item, deployment, or subscription is
mutated. This change does not add webhook subscriptions or alter alert
thresholds. Timing is asserted with a deterministic delayed loopback fixture,
not as a production latency benchmark. OpenClaw Bay is unaffected because it
remains an observer-only projection and gains no action surface.
