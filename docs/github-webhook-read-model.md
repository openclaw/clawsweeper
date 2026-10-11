# GitHub webhook read model

- Status: active architecture and operator reference
- Owner: ClawSweeper dashboard and queue maintainers
- Source of truth: `dashboard/github-webhook-read-model.ts`, `dashboard/worker.ts`, and `dashboard/exact-review-queue.ts`
- Last verified: this document's repository revision
- Update when: ingress coverage, App subscriptions, snapshot schema or indexes, TTLs, repair policy, or consumer safety boundaries change

The queue Durable Object materializes signed GitHub App deliveries into a bounded, freshness-labelled read model. It serves planning, discovery, hydration, and dashboard reads through publisher-HMAC endpoints. Each response says which webhook watermark it represents, whether the required event class has ever been observed, and whether the object is stale.

## Required GitHub App event subscriptions

Full read-model coverage requires the following repository events. Each
consumer requires only the event classes it reads; dashboard workflow health
in `poll` mode does not require workflow-run or workflow-job subscriptions.

| Subscription | Materialized state |
| --- | --- |
| Issues | Full issue lifecycle, labels, lock/state, assignees, milestones, and counts |
| Pull requests | PR lifecycle, head/base, draft/state, labels, and counts |
| Issue comments | Created, edited, and deleted comments, including ordinary non-command comments |
| Pull request reviews | Submitted, edited, and dismissed review activity |
| Pull request review comments | Created, edited, and deleted inline review comments |
| Workflow runs | Current and recently completed workflow-run state |
| Workflow jobs | Current job and step state |
| Check runs and check suites | Current check state associated with delivered commits |

Subscription readiness is detected per event class. A class remains unavailable until at least one signed delivery of that exact class has arrived. After the 30-minute probe window, consumers continue their live poll and emit one structured `github_read_model_degraded` line with `reason=never_observed`; enabling a related event does not satisfy the missing class.

### Dashboard workflow source

Dashboard workflow health always uses bounded GitHub run/job polling. The
retired workflow-source setting is no longer read: dashboard health neither
reads nor repairs workflow webhook snapshots and does not warn about missing
workflow subscriptions. Item/comment consumers, signed ingress, queue
operations, and ETag caching are unchanged. Dashboard polling does not require
new GitHub App event subscriptions.

## Stored schema and bounds

The Durable Object assigns one monotonic repository-wide watermark to every unique GitHub delivery GUID. Per-object rows retain the source `updated_at`, delivery GUID, object watermark, receipt time, and normalized JSON. Older deliveries with previously unseen GUIDs advance the global observation watermark but cannot replace a newer object row.

- One item row per repository and issue/PR number.
- Comments ordered by numeric ID, including deletion tombstones; at most 500 rows per item and 64 KiB per comment body.
- Reviews and inline review comments stored separately with tombstones, counts, and a stable activity digest; at most 500 rows per item.
- Workflow runs, jobs, check runs, and check suites; at most 1,000 current/recent objects.
- Delivery GUID receipts retained for 30 days.

Receipt cleanup uses a single-column `received_at` index, added idempotently by
the store initializer for both new and existing databases. Each accepted unique
delivery and repair still prunes at most 256 receipts strictly older than the
30-day cutoff, ordered by receipt time; equal timestamps have no specified tie
order. Retained GUIDs return their original watermark without pruning, and a
GUID can be accepted again after its receipt is pruned. The index changes only
the SQLite access path, not retention, constraints, transaction rollback, or
the public read-model contract. Building it on existing history has a one-time
initialization cost and adds storage and receipt-write work.

Item snapshots are stale after 15 minutes, comment and review collections after 30 minutes, and workflow state after 5 minutes. Placeholder discovery additionally requires a successful repair census within 6 hours. Missing, stale, incomplete, unsubscribed, or gap-detected snapshots fall back to GitHub and repair the Durable Object before later reads reuse it.

Item and placeholder projections preserve the stored issue/PR kind using the
Issues API's `pull_request` marker, including older rows whose JSON lacks that
marker. Raw PR webhook objects do not contain a nested marker. Planning therefore
keeps PR lease revisions tied to the live PR head, while issues retain their
source digest; the live head-drift and mutation guards are unchanged.

## Read and repair endpoints

Publisher-authenticated POST routes live below `/internal/state/github-read-model/`: `item`, `comments`, `activity`, `workflows`, `placeholders`, and `repair`. Authentication uses the same body HMAC as the other automated queue data-plane routes. Responses carry `watermark`, per-class subscription state, `freshness`, and `usable`; callers must not infer freshness from a successful HTTP response alone.

The consumers are exact-item review planning, review-placeholder discovery,
and repair-loop comment hydration in the comment router. Each retains a bounded
repair poll. Dashboard workflow health instead uses GitHub polling exclusively.

Stored workflow rows alone never establish completeness. Workflow read-model
snapshots require a persisted successful bounded run census, and job snapshots
require fresh complete coverage for each run. Census repair removes older rows
absent from the authoritative result while preserving webhook rows received
after the census began.


Publisher-HMAC remains the normal automated read credential. Exact-review planning intentionally does not receive that shared secret; its item read instead uses the already-issued full lease tuple as a scoped capability. The queue accepts that capability only for the tuple's live leased repository and item, and it cannot write or repair the read model.

## Hard safety boundary

This read model never serves apply mutation guards, the two-sided lease check, or any post-mutation verification. Apply binds those reads to a `LiveReadGeneration`, which bypasses the webhook snapshot; explicit final-guard bypass reads always reach GitHub. Placeholder deletion likewise re-reads the closed item and exact comment live immediately before deletion. Webhook state is asynchronous and lossy, so it is evidence for planning and observation—not authority to mutate GitHub.

OpenClaw Bay is unaffected. It remains an observer-only projection with the same public fields and no queue, workflow, GitHub, recovery, deploy, or rollback actions.
