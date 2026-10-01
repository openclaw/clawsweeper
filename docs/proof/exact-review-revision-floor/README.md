# Exact-review revision floor

Status: historical proof that a re-admitted exact-review item never reuses a
revision it already published. The owning code is `nextExactReviewItemRevisionSync`
and `nextExactReviewCommandRevisionSync` in `dashboard/exact-review-queue.ts`,
`ExactReviewCommandIntakeStore.allocateItemRevision`, and
`ExactReviewDirectPublicationStore.maxRevision`. The direct-receipt immutability
check, fencing, and claim protocol are unchanged.

## Claim and exercised surface

Before this change, ordinary item revisions were floored only on the
publication-head table. Direct publications never advance that table, and a
completed queue row is deleted. A re-admitted item was therefore handed the
revision it had just published directly, and the retained receipt rejected the
new review with `conflicting direct publication retry` (production:
openclaw/openclaw#97616 at revision 548, #161554 at 1, #143911 at 39-47).
Artifact-refresh recovery hard-coded revision 1, so its review fell below its
own publication head and was dropped as superseded.

After this change, every ordinary allocation comes from the durable per-item
counter and floors on the fence's retained direct receipt, the target's
lifecycle projections (lowercase and GitHub-cased key), and the publication
head. Refresh recovery uses the same allocator.

The harness bundles both checkouts into the real `ExactReviewQueue` Durable
Object in workerd with SQLite. It drives `/enqueue`, the queue's own alarm and
repository dispatch through a synthetic GitHub fixture, `/claim`, the real
HMAC-signed Worker route `/internal/exact-review/publication-results`,
`/complete`, `/publication-batches/claim` and `/publication-batches/complete`.

Scenarios, run on each build:

1. `direct_readmission`: admit, claim, publish directly, complete (the row is
   deleted), re-admit with an edit, claim, and publish a different review
   directly.
2. `mixed_case_direct_readmission`: the same for `openclaw/Peekaboo`.
3. `artifact_refresh`: a producer at revision 2 enqueues its batch publication
   and completes; the batch reports `refresh_required`; the recreated producer
   is claimed and enqueues its own publication.
4. Controls: a fresh item; an item admitted after a publication head of 12; a
   re-review command re-admitted after a direct publication.

A separate upgrade run persists SQLite written by the base build and reopens it
with the head build. The base build publishes two items directly and completes
them. Eight days later a third accept prunes the `openclaw/Peekaboo#365`
receipt, leaving only its GitHub-cased lifecycle projection. The head build
then re-admits both items.

## Command

```sh
node docs/proof/exact-review-revision-floor/run-proof.mjs <base-checkout> <head-checkout> <tools-dir> receipt.json
```

`<tools-dir>` contains `wrangler@4.107.0` installed with `--ignore-scripts`,
which provides workerd 1.20260701.1, Miniflare 4.20260701.0 and esbuild. Both
checkouts are clean detached worktrees. Bare imports resolve from the
`node_modules` of the checkout that runs the harness; the lockfile is
identical at both heads. Node v24.21.0.

| Build | Head | Clean tree |
| --- | --- | --- |
| before | `cac974b3e1da900cac3e7480b91d02a36ca60163` (origin/main) | yes |
| after | `ad1b80e4d6aec86247bf1b0437299a4bd7544612` (fix commit) | yes |

| Artifact | SHA-256 |
| --- | --- |
| `receipt.json` | `46d7991eed61e596c15180ed2cc585e3bc902e9a1340b1b72f9328e01c1a2b24` |
| `run-proof.mjs` | `f8e0607db68976b9ee4f9a1c163024afe6a18d07fc195df9e4118097654d736c` |

A second run reproduced `receipt.json` byte for byte. The receipt also records
the SHA-256 of each bundled runtime source file per build. It contains no local
paths, lease ids or secrets.

## Observed

| Scenario | Before | After |
| --- | --- | --- |
| direct re-admission | revision 1 again; second direct POST `400 conflicting direct publication retry` | revision 2; second direct POST `202 accepted`; receipts 1 and 2 published |
| mixed-case re-admission | revision 1 again; `400 conflicting direct publication retry` | revision 2; `202 accepted` |
| artifact refresh | recreated at revision 1; its publication `superseded` and deduped | recreated at revision 3; its publication queued |
| fresh item (control) | revision 1 | revision 1 |
| after publication head 12 (control) | revision 13 | revision 13 |
| command re-admission (control) | revision 2; `202 accepted` | revision 2; `202 accepted` |
| upgrade, retained receipt | base wrote revision 1 | head re-admits at 2; `202 accepted` |
| upgrade, pruned mixed-case receipt | base wrote revision 1; receipt pruned, no counter row | head re-admits at 2 from the GitHub-cased projection; `202 accepted` |

The fixture saw no unexpected GitHub request. Four batch-publisher workflow
dispatches were absorbed by the fixture.

## Limits

- The inputs, the 2030 clock and the GitHub fixture are synthetic. Hosted-target
  probes are injected as public.
- The sweep workflow, the review model and the deferred batch publisher that
  production falls back to after a rejected direct publication are not run.
- No production state, GitHub writes or inference were involved.
