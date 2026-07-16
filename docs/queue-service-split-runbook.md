# Exact-review queue Worker split runbook

This runbook moves the existing SQLite-backed `ExactReviewQueue` Durable Object
namespace from the `clawsweeper-status` Worker script to a dedicated Worker
script. It is a future operational plan only. Do not change either production
binding until the pre-checks pass and a maintenance owner has approved the
exact script names, migration tags, and rollback operator.

Cloudflare's [Durable Object migration documentation](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/#transfer-migration)
is authoritative. A cross-script move uses a `transferred_classes` migration on
the destination Worker. The transfer creates the destination class, moves the
stored objects, and automatically forwards existing source-class bindings to
the destination. Do not run `new_sqlite_classes` for the destination class
first. Migrations are atomic, cannot use gradual deployment, and each tag is
applied once per environment. External Durable Object bindings use Wrangler's
[`script_name` setting](https://developers.cloudflare.com/workers/wrangler/configuration/#durable-objects).

## Proposed topology

- Source script: `clawsweeper-status`.
- Source class and binding: `ExactReviewQueue` / `EXACT_REVIEW_QUEUE`.
- Destination script: choose and freeze a name such as
  `clawsweeper-exact-review-queue` before staging.
- Destination class and binding: keep `ExactReviewQueue` /
  `EXACT_REVIEW_QUEUE`; the script name makes the class namespace unambiguous.
- Public API during the first cut: keep
  `https://clawsweeper.openclaw.ai/internal/exact-review/*` and
  `/api/exact-review-queue` on `clawsweeper-status`. Its router uses an external
  binding to the destination script. Moving routes or changing
  `CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL` is a separate follow-up.

## Configuration inventory

Copy these queue-runtime values to the destination without changing them:

- `WORKER_BUDGET`
- `EXACT_REVIEW_QUEUE_MAX_CONCURRENT`
- `EXACT_REVIEW_TARGET_MAX_CONCURRENT`
- `EXACT_REVIEW_PUBLICATION_MIN_CONCURRENT`
- `EXACT_REVIEW_PUBLICATION_BASE_CONCURRENT`
- `EXACT_REVIEW_PUBLICATION_MAX_CONCURRENT`
- `EXACT_REVIEW_DISPATCH_LEASE_MS`
- `EXACT_REVIEW_EXECUTION_LEASE_MS`
- `EXACT_REVIEW_HEARTBEAT_GRACE_MS`
- `EXACT_REVIEW_WORKFLOW_PAUSED_RETRY_MS`
- `EXACT_REVIEW_DISPATCH_DEBOUNCE_MS`
- `EXACT_REVIEW_DISPATCH_DEBOUNCE_MAX_MS`
- `EXACT_REVIEW_PENDING_SOFT_LIMIT`
- `CLAWSWEEPER_ENABLE_CLAWHUB`, when set in the deployed environment
- GitHub App identity used for Actions reads and dispatch:
  `CLAWSWEEPER_APP_ID` or `CLAWSWEEPER_APP_CLIENT_ID`, optional
  `CLAWSWEEPER_APP_INSTALLATION_ID`, and secret
  `CLAWSWEEPER_APP_PRIVATE_KEY`

Keep `STATUS_STORE`, dashboard cache/telemetry variables, assets, dashboard
cron, custom domain, and `INGEST_TOKEN` on `clawsweeper-status`.
`CLAWSWEEPER_WEBHOOK_SECRET` can remain on the source while the source router
authenticates queue writes. If the public queue endpoints move later, copy that
secret in a separately reviewed route cutover; never print it while comparing
settings.

## Pre-checks

1. Freeze the source and destination script names, account, environment, and
   migration tag. Confirm the source script name from deployed Cloudflare
   settings, not only `dashboard/wrangler.toml`.
2. Record the current source deployment version and preserve its deployable
   artifact/config. Prepare, but do not apply, both the forward transfer and
   reverse-transfer rollback configs.
3. Run the full local queue test set and deploy the destination code to a
   non-production environment with a newly created test namespace. Prove
   enqueue, dedupe, claim, heartbeat, complete, reclaim, alarm, SQL migration,
   and `/stats` behavior there.
4. Establish the destination script without declaring or binding the
   destination Durable Object class. This inert staging deploy exists only so
   its secrets can be installed before the transfer. Do not use
   `new_sqlite_classes` for `ExactReviewQueue`.
5. Copy exact vars and secrets from the inventory above through approved secret
   tooling. Compare names and secret versions, never values. Prove the staged
   script has no public route.
6. Capture two source snapshots at least 30 seconds apart:

   ```bash
   curl --fail --silent --show-error \
     https://clawsweeper.openclaw.ai/api/exact-review-queue > before-1.json
   sleep 30
   curl --fail --silent --show-error \
     https://clawsweeper.openclaw.ai/api/exact-review-queue > before-2.json
   ```

7. Prefer a completely drained cut: `pending == 0`, `dispatching == 0`, and
   `leased == 0`. If zero pending cannot be reached, require `pending <= 5`, no
   growth between snapshots, oldest pending under three minutes, and an
   explicit operator decision. Do not transfer while any active lease exists.
8. Require dispatcher state `active` or an empty queue, handoff health `idle` or
   `healthy`, `shed_since_reset` unchanged, and no alarm/reconciliation errors
   in Worker logs. As a stale-lease safety gate, no dispatching lease may be
   older than the configured 6-minute dispatch TTL and no claimed lease may be
   older than the configured 130-minute execution TTL. A nonzero active count
   still blocks the planned drained cut even when under those limits.

## Forward deployment

1. Stop initiating optional/manual exact-review dispatches. Do not disable the
   live sweep workflow. Wait for the drained pre-check above.
2. Re-read `/api/exact-review-queue` immediately before deployment. Abort if
   depth increased, an active lease appeared, health degraded, or the source
   version changed.
3. Add the transfer only to the destination Worker's Wrangler config. Use the
   real frozen source script name and a new destination migration tag:

   ```toml
   [[durable_objects.bindings]]
   name = "EXACT_REVIEW_QUEUE"
   class_name = "ExactReviewQueue"

   [[migrations]]
   tag = "v1-transfer-exact-review-queue"

     [[migrations.transferred_classes]]
     from = "ExactReviewQueue"
     from_script = "clawsweeper-status"
     to = "ExactReviewQueue"
   ```

   The destination Worker must export `ExactReviewQueue`. Do not add
   `new_sqlite_classes = ["ExactReviewQueue"]`.

4. Deploy the destination Worker once with the transfer. Treat any ambiguous
   Wrangler result as a stop condition: inspect deployed versions and migration
   state before retrying. Do not change the tag and blindly retry.
5. Verify the existing source URL immediately. Source bindings should forward
   after the transfer, so `/api/exact-review-queue` must still return the same
   queue namespace before the source Worker is redeployed.
6. Update the source binding to the external destination script and deploy the
   source Worker:

   ```toml
   [[durable_objects.bindings]]
   name = "EXACT_REVIEW_QUEUE"
   class_name = "ExactReviewQueue"
   script_name = "clawsweeper-exact-review-queue"
   ```

   Keep the source's historical `v1`/`v2` migration entries. Do not delete the
   old migration history or add a delete migration.

## Verification

1. Fetch `/api/exact-review-queue` through the unchanged public source route.
   Compare these fields with the final pre-transfer snapshot:

   - `pending`, `dispatching`, `leased`, and `shed_since_reset`
   - `dispatcher.state`, `dispatcher.reason`, and `dispatcher.retry_at`
   - `lanes.review` and `lanes.publication` depth, active count, capacity, and
     next attempt
   - `target_stats`, `next_wake_at`, and `handoff_health`

   Timestamps may advance; counts, item ownership, capacities, and cumulative
   publication telemetry must not reset or disappear.

2. Tail both Workers. The source should show router traffic but no local
   `ExactReviewQueue` execution. The destination should show the queue fetches
   and alarms, with no storage-schema, GitHub App, dispatch, or alarm errors.
3. Enqueue one low-risk exact-review canary through the existing signed path.
   Confirm one accepted/deduped response, one dispatch, one tuple-safe claim,
   heartbeats, completion, and return to the prior depth. Do not use a live
   close/apply command as the canary.
4. Run the signed terminal reconciliation workflow and verify zero unexpected
   requeues. Recheck stats after one alarm interval and after 15 minutes.
5. Resume optional/manual intake only after both observation windows remain
   healthy. Record deployed version IDs, migration tag, before/after snapshots,
   canary run, and operator.

## Rollback

Application rollback and namespace rollback are different:

- If the destination class is healthy but the source router deploy is bad,
  redeploy the last known-good source router. Cloudflare's automatic forwarding
  keeps its old source-class binding reaching the transferred namespace. Do not
  attempt a state migration for this case.
- If the destination class/runtime must be removed, do not merely roll back a
  Worker version or delete the destination migration tag. Prepare a new,
  uniquely tagged reverse `transferred_classes` migration on
  `clawsweeper-status`, with `from = "ExactReviewQueue"`,
  `from_script = "clawsweeper-exact-review-queue"`, and
  `to = "ExactReviewQueue"`. Deploy the source reverse transfer first, verify
  forwarding and stats, then update/remove the destination's local binding in a
  separate deploy.
- Apply the same drain gates before reverse transfer. A rollback under active
  leases risks duplicated workflow dispatch or delayed completion even though
  the namespace transfer itself is atomic.
- Never use `deleted_classes`, a fresh `new_sqlite_classes`, or manual data copy
  as rollback. Escalate to Cloudflare support before destructive recovery if a
  reverse transfer is rejected or stats show missing state.

Because Durable Object migrations are atomic and excluded from gradual
deployments, practice both the forward and reverse transfer in a non-production
environment before scheduling production.
