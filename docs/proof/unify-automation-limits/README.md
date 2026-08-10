# Automation-limits unification value-equivalence proof

This proof establishes that consolidating `src/limits.ts` and `src/repair/limits.ts` into the
canonical `src/limits.ts` preserves the union of their runtime value surfaces.

## Claim

Every exported config value, derived automation limit, and lane budget is identical before and
after the consolidation. The old union includes the repair-only exact-review target and assist
values as well as every value shared with the root module.

## Scenario

Run `docs/proof/unify-automation-limits/run-proof.sh` from a checkout of this branch. The script:

1. fetches `origin/main`, computes its merge base with the checked-out head, and selects
   `origin/main` when the historical modules and config still match the merge base;
2. reconstructs the pre-change `src/limits.ts` and `src/repair/limits.ts` with `git show` in
   isolated temporary module trees, then compiles both historical modules and the current
   canonical module with the repository's TypeScript compiler;
3. imports all three compiled modules and writes canonical, recursively key-sorted JSON for
   `WORKER_CONFIG`, `AUTOMATION_LIMITS`, `readWorkerConfig()`, `deriveAutomationLimits()`, and
   `workerLimit()`;
4. exercises worker maxima 64, 128, and 256, all eight union lanes, and default, active-worker,
   soft-pressure, hard-pressure, and unknown-pressure scenarios;
5. requires an empty unified diff and runs `pnpm run check:limits`.

If `origin/main` changes any historical limit module or `config/automation-limits.json` after the
branch base, the script pins the merge-base SHA instead and records that decision. Set
`UNIFY_AUTOMATION_LIMITS_PROOF_OUTPUT` to write artifacts outside the repository.

## Observations

The committed local run selected `origin/main` because its historical modules and config remain
identical to merge base `35b5f622c968cf3acb2fbe8226ffeef801422a88`. The pre-change union and
current canonical JSON dumps are byte-identical, so
[`artifacts/value-equivalence.diff`](artifacts/value-equivalence.diff) is empty.
[`artifacts/check-limits.log`](artifacts/check-limits.log) records the passing repository drift
check. [`artifacts/baseline.json`](artifacts/baseline.json) records the resolved source SHAs.

## Limits

This proves deterministic config parsing, limit derivation, and lane-budget behavior for the
recorded scenarios. It does not dispatch GitHub Actions, exercise production queues, or claim that
unrelated scheduler behavior is unchanged.

