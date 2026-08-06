# Scheduler duplicate-candidate stranding proof contract

## Claim

`selectDueCandidates` fills the review batch up to capacity from the candidates
it is given, even when the same item appears twice in the due list. Before this
change, a single duplicated entry could end selection early and strand every
remaining candidate while capacity was still free.

## Exercised surface

The shipped planner path, not the comparator in isolation:

```
createReviewPlanningSelection(...).selectCandidates()
  -> src/clawsweeper-review-planning-selection.ts:90-111
  -> selectDueCandidates()   (src/scheduler-policy.ts)
```

The only injected behavior is `fetchOpenItemPage`, which reproduces the real
GitHub artifact that triggers this: `GET /issues` is sorted by `updated`, so an
item touched between two page reads shifts pages and is returned on both. Every
step after that is the real planner. The `selectedKeys` dedup set inside
`selectDueCandidates` exists precisely because this case is expected.

## Controlled scenario and fixture

`run-proof.mjs` builds one planner per scenario over three distinct open issues
(`#1`, `#2`, `#3`) with `batchSize: 10` — far above the number of due items, so
capacity can never be the limiting factor.

- **control** — two pages, no race: `[[#1, #2], [#3]]`
- **subject** — two pages, `#1` shifted onto page 2 as well: `[[#1, #2], [#1, #3]]`

Every candidate is placed in the `weekly_issue` bucket, whose weight is **1**, so
one duplicate is enough to consume a whole weighted pass.

### Timing detail that matters

`selectCandidates()` calls `selectDueCandidates()` **without** a `now` argument,
so the scheduler uses the real `Date.now()`. The fixture therefore anchors
`reviewedAt` to `Date.now() - 1h`, which keeps the candidates *out* of the
weekly-coverage preselect lane (that lane needs 6 days).

This is load bearing. An earlier version of this proof used a fixed past
timestamp; every candidate then qualified as weekly-coverage-due and was taken by
the plain `for (const candidate of weeklyCoverageDue) take(candidate)` loop, which
never reaches the weighted drain. That version passed on a pre-fix build and
proved nothing.

## Expected observation

| build | control | subject |
|---|---|---|
| pre-fix | `[1, 2, 3]` | `[1]` — `#2` and `#3` stranded |
| post-fix | `[1, 2, 3]` | `[1, 2, 3]` |

The proof also asserts the subject result stays deduplicated, so the fix cannot
be satisfied by simply letting the duplicate through.

## Artifact and command

```bash
pnpm run build
node docs/proof/scheduler-duplicate-candidate-stranding/run-proof.mjs   # exit 0 = PASS
```

Focused tests:

```bash
node --test test/scheduler-policy.test.ts
```

Red/green was verified by stashing only `src/scheduler-policy.ts`, rebuilding, and
re-running the focused suite with the new tests present: 3 fail pre-fix, 23/23
pass post-fix, with all 20 pre-existing assertions unchanged in both directions.

## Limits

Covers the batch-selection path only. It does not exercise a live GitHub listing,
Worker, or queue — the duplicate is injected at the `fetchOpenItemPage` boundary
rather than produced by a real pagination race, because that race is timing
dependent and not reproducible on demand.

The fix changes only the loop's termination signal (candidates drained instead of
candidates selected). It does not deduplicate the `due` list up front, does not
change bucket weights, ordering, or the dedup key, and does not change behavior at
all for a due list with no duplicates. A duplicate still consumes one weighted
slot in its pass; only the premature `break` is removed.
