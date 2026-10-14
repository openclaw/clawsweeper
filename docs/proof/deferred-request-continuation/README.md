# Deferred request continuation proof

An explicit `@clawsweeper re-review` on a maintainer item must still be answered
when the item changes after its review handed the verdict to a deferred
publication. The publisher then requeues the claimed decision as
`source_drift_requeue` while it still holds that publication. This proof follows
that requeue from the queue to the final GitHub effects, shows that finished,
replaced, and lease-expired requests stop before any write, and reopens state
persisted by the deployed release.

## Behavior contract

- **Claim:**
  - The queue keeps the request's verification only while the publisher still
    holds the request's newest publication and no other command reached the
    item. The decision handed to the review job then publishes and closes
    through the real apply owner.
  - A requeue after the publication finished, after the publisher lease was
    lost, after a newer request was answered, or after a newer publication was
    admitted reaches the apply owner without authority and makes no write. So
    does an older producer's requeue while a newer publication of the same
    request is held: the requeue's delivery id binds it to its own producer.
  - Rows persisted by the deployed release load unchanged and take the new
    paths after the upgrade.
- **Surfaces:**
  - The real `ExactReviewQueue` Durable Object routes `/enqueue`, `/claim`,
    `/complete`, and its alarm dispatcher, with the lifecycle projection store.
  - The real apply owner (`apply-decisions --exact-event-publication`) on the
    OWNER-authored oversized pull request fixture of
    [`test/oversized-pr-close.test.ts`](../../../test/oversized-pr-close.test.ts),
    with a recording `gh`.
- **Scenarios:**
  - [`test/exact-review-deferred-publication-fixture.ts`](../../../test/exact-review-deferred-publication-fixture.ts)
    `deferredContinuationClaim`: a verified request is reviewed, the review
    enqueues its publication, a publisher run claims it, then (per scenario)
    nothing happens, the publication completes, the clock passes the lease, a
    newer request reusing the status comment is answered (also under another
    repository casing), a newer review
    generation's publication is admitted, or a second generation of the same
    request holds its own publication when the older producer's requeue arrives
    (and then answers the request). The publisher then sends the exact
    body of `enqueue source-drift`, and the requeued item's claim returns the
    decision under test.
  - [`upgrade.mjs`](upgrade.mjs): `origin/main` persists a held command
    publication, a leased publication with a newer request queued behind it,
    an ordinary queued request, and a pending terminal finalizer to file-backed
    SQLite. Another release reopens those exact files and continues.
- **Commands:**

  ```bash
  node --test --test-name-pattern="exact-close-held" test/oversized-pr-close.test.ts
  node --test test/exact-review-source-drift-loop.test.ts
  node docs/proof/deferred-request-continuation/upgrade.mjs seed <main checkout> <fresh dir>
  node docs/proof/deferred-request-continuation/upgrade.mjs verify <release checkout> <copy of dir>
  ```

  Each checkout needs `node_modules` and `pnpm run build:all`. Environment:
  macOS, Node 24.21.0, pnpm 12.4.1, no network (GitHub calls are answered by a
  local stub with a synthetic key).
- **Observable result:** apply actions and the recorded `gh` writes; queue rows,
  claimed decisions, lifecycle dispositions, and finalizer drivers after the
  upgrade.
- **Artifacts:** [`final-effects.json`](final-effects.json) and
  [`upgrade-result.json`](upgrade-result.json).
- **Limits:**
  - Controlled proof on the real queue and apply owner, not a live GitHub run.
  - Review execution is replaced by claim and successful completion.
  - The publisher workflow step is reproduced by its request body, which
    `test/repair/exact-review-batch-workflow.test.ts` pins for both publishers.

## Final effects

| Requeue after | Apply actions | Recorded writes |
| --- | --- | --- |
| Nothing (publication still held) | `review_comment_synced`, `closed` | `POST issues/141913/comments` (durable review), `pr close 141913`, `PATCH issues/comments/150913` (close notice) |
| Publication finished | `skipped_maintainer_authored` | none |
| Publisher lease lost | `skipped_maintainer_authored` | none |
| Newer request answered (same status comment, new marker) | `skipped_maintainer_authored` | none |
| Newer request answered under another repository casing (`OpenClaw/OpenClaw`) | `skipped_maintainer_authored` | none |
| Newer publication admitted | `skipped_maintainer_authored` | none |
| Older producer's late requeue while a newer publication of the same request is held; that publication then answers | `skipped_maintainer_authored` | none |

## Upgrade from the deployed release

State seeded by `origin/main` `bc3ae1d960`, reopened by #1981's head `131383c7`
and by this branch:

| Persisted row, next step | #1981 head | This branch |
| --- | --- | --- |
| Held command publication, publisher requeues | stored as `publisher-source-drift:…`, verification dropped; claim not explicit | stored as `held-publication-requeue:publisher-source-drift:…`, verified; claim explicit |
| Leased publication refreshed with a newer request queued | queued request rewritten to `artifact_retention_recovery` with the older marker; lifecycle `requeue`; newer request not explicit | queued `re_review` unchanged and explicit; refreshed command `superseded` with a terminal finalization |
| Pending terminal finalizer, organic `edited` | successor carries the finalized marker and verification | successor carries no command; the driver keeps the marker |
| Ordinary queued request | claim explicit | claim explicit |

Every persisted row loads on both releases, and `/stats` answers 200.
