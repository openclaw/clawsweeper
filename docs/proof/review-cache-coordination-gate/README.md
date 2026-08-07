# Proof: scheduled reviews never reused a cached verdict

## Claim

A scheduled delivery of an unchanged item re-ran full hydration and Codex every
pass. Three conditions on the same cache-eligibility path each blocked reuse, and
all three had to go for the outcome to change:

1. **`coordination_disabled`** — `sweep.yml` reserves the review lease in its own
   write-token step, so it must pass `--skip-start-comment`; that flag also
   decided `coordinationEnabled`, which the probe consults before anything else.
   The probe never ran, so `preHydrationStructuralRecord` stayed `null` and the
   seeding branch could never persist a receipt for the next review either.
2. **`activity_changed`** — the reservation the workflow posts is itself the
   item's newest activity, landing after the sync markers the prior review
   recorded, so ClawSweeper's own write read as reporter activity.
3. **`target_changed`** — the decision compared the target repository's default
   branch head across reviews. That head advances for reasons unrelated to the
   item, so where it moves faster than the review cadence the key can never match.

## Level

Module-level captures against the built `dist/` output using production argument
values, plus end-to-end runs of the shipped `review` command against a live
GitHub item. Not a trace against a production target; see Limits.

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

- The pre-fix production observation narrows the reason by elimination from
  public state; it does not read the probe's returned reason directly. Reading it
  directly on a production target would need the organization's App installation
  token, which only repository operators can exercise. #1036 disclosed the same
  limit. The end-to-end section below closes part of this gap on a repository the
  proof author owns.
- The end-to-end section below reaches a structural cache hit with no hydration
  and no Codex call, including after the target branch advanced. The runs use one
  repository the proof author owns; behaviour on a production target is inferred
  from the shipped code being identical, not observed. `openclaw/openclaw` is the
  case that motivates this: its default branch advanced 100 times in the 21h11m
  ending 2026-08-07, roughly once every 13 minutes, against a daily review
  cadence.
- No production review jobs were dispatched, no model capacity was consumed, and
  no contributor notifications were generated while validating this change.

## End-to-end run against a live GitHub item

The module-level captures above stop at the probe decision. This section drives
the shipped `review` command itself, against a real issue, so the reserved-lease
claim and the receipt-persistence path are exercised rather than inferred.

### Setup

- Target: <https://github.com/masatohoshino/clawsweeper-cache-proof> issue 1, a
  repository the proof author owns. Nothing was run against a production target.
- Runner: the branch at `51276d4a`, built and executed from a copy of that tree.
  The only difference from the branch is one added entry in
  `config/target-repositories.json` `generic_fallbacks`, so the proof author's
  own account is onboarded the same way `openclaw/*` and `steipete/*` already
  are. **No source file differs**, and that entry is not part of this PR.
- `CLAWSWEEPER_COMMENT_AUTHOR_LOGIN` names the proof author, which is the
  supported way to extend `PATCHABLE_REVIEW_COMMENT_AUTHORS`
  (`src/clawsweeper-review-comment-state.ts`).
- Leases were created by `pnpm run reserve-review-lease`, the same command
  `.github/workflows/sweep.yml` uses. No marker was hand-written.
- Every review ran with `--review-source-action scheduled_normal_backfill`,
  `--skip-start-comment`, and the reserved lease, matching the workflow.

### Runs

| Run | Prior state | Result |
| --- | --- | --- |
| 1 | no prior review | full hydration; report written with an unseeded receipt |
| 2 | prior review present, receipt unseeded | full hydration; **receipt seeded** |
| 3 | receipt seeded, no durable review comment | **reserved lease claimed**; revalidation stopped at `previous_review_changed` |
| 4 | durable review comment published | structural stopped at `activity_changed`; model skipped by the content stage |
| 5 | same state, with the reservation recognised | **structural cache hit; no hydration, no Codex** |

### The reserved-lease claim runs

Run 3, the line emitted only by the claim branch this PR adds:

```text
[review] shard=0/1 structural-cache-start-comment=reserved #1
```

Reaching that line requires the probe to pass coordination and the structural
decision to hit, and the claim itself to elect the reserved lease as winner
through the same freshness checks the hydrated path uses. On `main` this item
would have stopped at `coordination_disabled` before any of it.

### The receipt is persisted

Run 1 and run 2 differ only in whether a prior completed review existed:

```text
run 1 report:  review_structural_target_head_sha: unknown
run 2 report:  review_structural_target_head_sha: b575dc7ad47e96e62288ab26eb84d5c5b5b22adf
```

Run 2's metrics record the seeding path validating its own anchor:

```json
"structural_cache_revalidation_reasons": { "hydrated_anchor_match": 1, "verdict_input_match": 1 }
```

This is the production symptom — reports published with
`review_structural_target_head_sha: unknown` — reproduced locally and then
cleared.

### The structural cache hits, with no hydration and no Codex

Run 4 stopped one gate later, at
`"structural_cache_reasons": { "activity_changed": 1 }`: the reservation comment
`reserve-review-lease` posts is itself the item's newest activity, and it lands
after the sync markers the prior review recorded, so `activityCoveredByReview`
could not attribute it. Recognising the already-validated reservation — and only
that reservation — closes it. Run 5, same item, same reserved lease, same
recorded verdict:

```text
[review] shard=0/1 structural-cache-start-comment=reserved #1
[review] shard=0/1 cache-hit structural-unchanged skip-hydration-model #1 (1/1)
[review] shard=0/1 complete reviewed=1 cache_hits=1 structural_cache_checks=1
  structural_cache_hits=1 structural_cache_revalidations=1 ... content_cache_hits=0
  hydrations=0
```

```json
"structural_cache_reasons": { "hit": 1 },
"structural_cache_revalidation_reasons": { "hit": 1 }
```

The carried report records the reuse:

```text
review_cache_hit: true
review_structural_cache_hit: true
```

`hydrations=0` is the point: the run neither hydrated GitHub context nor called
Codex. It took 8 seconds end to end, against 70-150 seconds for the full reviews
in runs 1-3.

### An unrelated commit on the target branch no longer forces a full review

The runs above kept the target repository's `main` still. Advancing it by one
commit that has nothing to do with the item — a comment appended to `README.md`,
where the item is about `src/slug.js` — was enough to lose the hit before this
change:

```text
structural_cache_reasons: { "target_changed": 1 }
cache_hits=0  hydrations=1                      (103 s, full hydration + Codex)
```

Same item, same reserved-lease flow, same advanced `main`, after the change:

```text
[review] shard=0/1 structural-cache-start-comment=reserved #1
[review] shard=0/1 cache-hit structural-unchanged skip-hydration-model #1 (1/1)
[review] shard=0/1 complete reviewed=1 cache_hits=1 structural_cache_checks=1
  structural_cache_hits=1 ... content_cache_hits=0 hydrations=0
```

```json
"structural_cache_reasons": { "hit": 1 }
```

8 seconds instead of 103, with no Codex call. Staleness is still bounded: the
probe rejects any recorded verdict older than
`REVIEW_STRUCTURAL_CACHE_MAX_AGE_DAYS`, so a full review still runs periodically
regardless of what `main` did. No new constant is introduced.

### What this run did not establish

- Run 4's content-stage hit (`cache-hit content-unchanged skip-model`) is **not**
  attributable to this PR. The content stage takes its coordination from
  `Boolean(acquiredReviewLease)`, which the pre-existing post-hydration claim
  already satisfies on `main`. It is recorded because it happened.
- The durable review comment runs 4 and 5 needed was published with
  `apply-decisions --sync-comments-only --skip-dashboard`, the documented local
  apply repro, rather than by the production publication lane.
- The runs use one repository the proof author owns. Behaviour on a production
  target is inferred from the shipped code being identical, not observed.

## Controlled environment run (Crabbox `local-container`)

The runs above executed on the author's host. This one repeats the focused
validation inside a Docker-backed Crabbox lease at the current head, which is
the controlled envelope `AGENTS.md` asks for on code-bearing changes.

| Field | Value |
| --- | --- |
| Provider | `local-container` (Docker) |
| Runtime | Docker 29.4.2, context `default` |
| Image | `ubuntu:26.04` @ `sha256:678c6550cc43645e08669028bc177f50be4e7c5b8cca677067b1914d4afc7a03` |
| Lease | `cbx_6e190a5c1faa` (slug `cache-gate-proof`, container `492644ca26eb`, type `ubuntu_26.04`) |
| Head | `d8d7c31dbd248c569c0e32368b65e2a9beb58893` |
| Node | v24.19.0, pnpm 11.10.0 |
| Artifact | `cbx_6e190a5c1faa-artifacts.tgz`, 8882 bytes, sha256 `65f220b7afa0d4fd4980703b1d2e0f4ff3abf851d9b4b5c1225d6f550ae796e8` |
| Captured | 2026-08-07T05:53:12Z |

Commands, from a clean lease:

```sh
crabbox doctor  --provider local-container
crabbox warmup  --provider local-container --slug cache-gate-proof
crabbox run     --provider local-container --id cache-gate-proof --no-hydrate \
  --artifact-glob '.artifacts/cache-gate-proof/*' -- \
  'node --test test/review-preparation.test.ts test/review-structural-cache.test.ts \
     test/review-semantic-cache.test.ts test/review-content-cache.test.ts \
     test/sweep-workflow.test.ts test/local-review.test.ts \
     test/local-range-review.test.ts test/command.test.ts;
   node docs/proof/review-cache-coordination-gate/run-proof.mjs'
```

Result inside the lease:

```text
head=d8d7c31dbd248c569c0e32368b65e2a9beb58893
node=v24.19.0
os=Ubuntu 26.04 LTS
tests exit=0
ℹ tests 271
ℹ pass 271
ℹ fail 0

build                     post-fix
coordinationEnabled       true
structural probe          {"hit":true,"reason":"hit"}
```

The collected artifact holds `env.txt`, `tests.txt`, and `harness.txt` from that
run.

### Limits of this envelope

- The lease is a local Docker container on the author's machine, not the
  organization's AWS Crabbox capacity; `.crabbox.yaml` targets `provider: aws`
  and this run overrode it with `--provider local-container`, the Linux path the
  provider documentation describes.
- The base image ships without `jq`, `zip`, `unzip`, or `gh`. Installing them is
  part of the run: without them 29 workflow-shell assertions in
  `test/sweep-workflow.test.ts` and neighbours fail on missing tooling rather
  than on behaviour. That is an environment gap, not a result — it is recorded
  so the run is reproducible.
- `--no-hydrate` is used because the repository's Actions hydration path rejects
  the `pnpm/action-setup@v6.0.9` step under local Actions emulation.
- The live-GitHub end-to-end runs in the previous section are not repeated here;
  they need GitHub credentials, which are deliberately kept out of the lease.
