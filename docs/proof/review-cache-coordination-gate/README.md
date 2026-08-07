# Proof: the exact-event lane could not reach its own structural receipt

## Claim

`.github/workflows/sweep.yml` reserves the durable review lease in its own
write-token step, so it must invoke the review command with
`--skip-start-comment`. That flag also decided `coordinationEnabled`, which
`reviewStructuralCacheProbeDecision` consults before anything else. Scheduled
deliveries therefore returned `coordination_disabled`, skipped the probe, and
re-ran full hydration plus Codex on unchanged items — and because the probe
never ran, `preHydrationStructuralRecord` stayed `null` and the seeding branch
could never persist a receipt for the next review either.

## Level

Module-level proof against the built `dist/` output, using production argument
values. It is not a live end-to-end trace; see Limits.

## Exercised surface

```
parseArgs -> suppliedReviewStartLeaseFromArgs -> isExplicitReviewDispatch
          -> isReviewCoordinationEnabled -> reviewStructuralCacheProbeDecision
```

No production module is stubbed or replaced; each runs its shipped
implementation. The one synthetic value is the prior review record, standing in
for a completed keep-open review of an unchanged item.

The probe decision is the last thing the harness observes. What the review
command does next — hydrate and call Codex, or write the carried report — is not
exercised here, which is why the final line is labelled as an implication.

The flag list is parsed out of `.github/workflows/sweep.yml` rather than
restated, and the harness aborts if production stops passing
`--skip-start-comment`, `--review-lease-owner`, and `--review-source-action`
together. Every argument value comes from one real delivery — openclaw/clawscan#7
reviewed by clawsweeper run
<https://github.com/openclaw/clawsweeper/actions/runs/31131759207> — so the
fixture is not assembled from different items.

## Command

```bash
pnpm run build
node docs/proof/review-cache-coordination-gate/run-proof.mjs
```

## Observed result

Pre-fix, at `2eb1787e0d183a84f29e84614b84f228037ba69f`:

```text
build                     pre-fix (upstream/main)
skipStartComment          true
suppliedReviewLease       {"owner":"github-run-31131759207-1","commentId":5210008452}
explicitDispatch          false
coordinationEnabled       false
structural probe          {"hit":false,"reason":"coordination_disabled"}
implied next step (not run here)  full hydration + Codex
```

Post-fix, same command, same workflow flags:

```text
build                     post-fix
skipStartComment          true
suppliedReviewLease       {"owner":"github-run-31131759207-1","commentId":5210008452}
explicitDispatch          false
coordinationEnabled       true
structural probe          {"hit":true,"reason":"hit"}
implied next step (not run here)  reuse the recorded verdict
```

`explicitDispatch` is already `false` on both sides:
<https://github.com/openclaw/clawsweeper/pull/1036> landed that half. The gate
immediately below it is what this change addresses, and the two flags that
produce them sit on adjacent lines of the same `pnpm run review` invocation
(`sweep.yml:1229` and `sweep.yml:1234`).

## Production observation for the pre-fix side

Run <https://github.com/openclaw/clawsweeper/actions/runs/31131759207> reviewed
openclaw/clawscan#7 starting 2026-08-06T23:36:45Z, from clawsweeper head
`3f368a3e394d76c31584fce700cee9a62485cb66` — after
<https://github.com/openclaw/clawsweeper/pull/1036> merged at 2026-08-06T18:01Z.
The alternative reasons the probe could have returned are excluded by public
state at that moment:

| Candidate reason | Excluded by |
| --- | --- |
| `explicit_dispatch` | `sourceAction: scheduled_hot_intake`, which #1036 made automatic |
| `missing_review` / `incomplete_review` | the durable review comment on that PR has existed since 2026-07-01 |
| `target_changed` | `openclaw/clawscan` `main` last moved 2026-08-03T16:01:55Z, three days earlier |
| `pull_head_changed` | the PR has one commit, dated 2026-08-03T16:04:07Z; head `bb644fe1646cbd7f74c81947259ec5b042fad776` |

The run logged `--skip-start-comment` taking effect and no cache reuse:

```text
[review] shard=0/1 start-comment=skipped #7
[review] shard=0/1 complete reviewed=1 cache_hits=0 structural_cache_checks=1
  structural_cache_hits=0 structural_cache_revalidations=0 semantic_cache_checks=1
  semantic_cache_hits=0 semantic_cache_ineligible=1 semantic_cache_revalidations=0
  content_cache_hits=0 hydrations=1
```

A pull request whose head had not moved in three days, on a repository whose
`main` had not moved in three days, with a review record already on file, was
hydrated and re-reviewed in full.

## Limits

- No live claimed-delivery trace through the GitHub receipt-cache boundary: that
  needs the organization's App installation token, which only repository
  operators can exercise. #1036 disclosed the same limit. The production
  observation above narrows the pre-fix reason by elimination from public state;
  it does not read the probe's returned reason directly.
- This restores the probe and the seeding path. It does not by itself produce
  cache hits on `openclaw/openclaw`, because `reviewStructuralCacheDecision`
  separately compares the target repository's `main` head between reviews
  (`src/review-structural-cache.ts:1280`), and that head advances roughly every
  13 minutes there (100 commits in 21h11m, measured 2026-08-07). Whether an
  unrelated `main` commit should invalidate a pull request's verdict is a design
  question, filed separately.
- No production review jobs were dispatched, no model capacity was consumed, and
  no contributor notifications were generated while validating this change.
