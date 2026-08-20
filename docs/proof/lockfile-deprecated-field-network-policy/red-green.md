# RED / GREEN evidence

Both runs executed inside the same Crabbox `local-container` lease (`cbx_c6901e89c73a`, slug `harbor-barnacle`, image `node:24-bookworm`), against a fresh clone of the real `openclaw/openclaw` repository at `e2f841bf1c1286940e3e89627ec2dc02514d9325`, which carries the actual triggering `deprecated` lockfile entry. See `receipt.json` for full environment binding.

## RED — unfixed code (worktree built from `3ca46ac`, the commit immediately before this fix)

```
PROOF_TARGET=openclaw/openclaw@e2f841bf1c1286940e3e89627ec2dc02514d9325
PROOF_ENTRY=prepareTargetToolchain
PROOF_DEPRECATED_FIELD_PRESENT=true
PROOF_ERROR_MESSAGE=target dependency install destination is not approved: https://github.com
PROOF_NETWORK_POLICY_DESTINATION_REJECTED=true
```

This reproduces the exact error from production run
[`32367984753`](https://github.com/openclaw/clawsweeper/actions/runs/32367984753).

## GREEN — fixed code (this branch, head `d799ee7713284cca574be168c6bc0fb6f864f01e`; the docs commit adding this proof directory came after and changes no tested file)

Two separate runs against the fixed code, both confirming the same conclusion:

**Manual run** (target checkout `e2f841bf1c1286940e3e89627ec2dc02514d9325`):

```
PROOF_TARGET=openclaw/openclaw@e2f841bf1c1286940e3e89627ec2dc02514d9325
PROOF_ENTRY=prepareTargetToolchain
PROOF_DEPRECATED_FIELD_PRESENT=true
PROOF_ERROR_MESSAGE=validation process containment failed: stage=namespace_setup exit=1
PROOF_NETWORK_POLICY_DESTINATION_REJECTED=false
```

**`run-proof.sh` run**, executed standalone end-to-end exactly as a re-runner would invoke it (target checkout advanced to `8c6c7a30cfb6e27fdf4ae7ec5b92d3ce015b501a` between runs, a fresh shallow clone of `openclaw/openclaw`'s moving `main`):

```
PROOF_TARGET=openclaw/openclaw@8c6c7a30cfb6e27fdf4ae7ec5b92d3ce015b501a
PROOF_ENTRY=prepareTargetToolchain
PROOF_DEPRECATED_FIELD_PRESENT=true
PROOF_ERROR_MESSAGE=command timed out after 8ms: git -c core.hooksPath=... hash-object -w -- .agents/skills/... [truncated: full repo file list, checkout-identity hashing step]
PROOF_NETWORK_POLICY_DESTINATION_REJECTED=false
```

In both runs the network-policy rejection is gone (`PROOF_NETWORK_POLICY_DESTINATION_REJECTED=false`). Execution proceeds past `assertTargetInstallNetworkPolicy` entirely and reaches a later stage before the 8-second proof budget runs out, `namespace_setup` in the first run, `git hash-object` checkout-identity hashing in the second. Both later-stage failures are proof-budget/environment artifacts (a real install needs far more than 8 seconds, and this container additionally lacks delegated user namespaces / Landlock ABI 3+, the identical gate the focused test suite's 3 skipped tests hit: `validation rejects and reaps an immediate detached double fork` and its siblings, `runner does not provide delegated user namespaces and Landlock ABI 3+`). Neither is the original bug, both are only reachable at all once the code under test progresses further than it did before the fix, where it used to fail immediately and deterministically at the network-policy stage.

## Focused unit suite, same lease

```
ℹ tests 205
ℹ pass 202
ℹ fail 0
ℹ cancelled 0
ℹ skipped 3
ℹ todo 0
```

The 3 skips print the same kernel-capability reason inline, matching the RED/GREEN observation above: `# runner does not provide delegated user namespaces and Landlock ABI 3+`.

## Static gates, same lease

```
$ pnpm run format:check
All matched files use the correct format.
Finished in 339ms on 744 files using 28 threads.

$ pnpm run lint
lint:repair  Found 0 warnings and 0 errors. (166 files, 96 rules)
lint:scripts Found 0 warnings and 0 errors. (317 files, 96 rules)
lint:dashboard Found 0 warnings and 0 errors. (34 files, 95 rules)
lint:src     Found 0 warnings and 0 errors. (167 files, 111 rules)

$ pnpm run build:all
$ tsc -p tsconfig.json        (clean)
$ tsc -p tsconfig.repair.json (clean)
$ tsc -p tsconfig.dashboard.json (clean)
```
