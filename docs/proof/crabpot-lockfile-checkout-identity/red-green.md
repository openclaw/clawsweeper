# RED / GREEN evidence

## Focused unit suite and static gates — Crabbox `local-container` lease

Both runs executed in the same lease (`cbx_3e31cb90a5dd`, slug `coral-krill`, container `237d4fcec872`, image `node:24-bookworm`). See `receipt.json` for full environment binding.

```
$ pnpm run format:check
All matched files use the correct format.
Finished in 330ms on 744 files using 28 threads.

$ pnpm run lint
lint:repair  Found 0 warnings and 0 errors. (166 files, 96 rules)
lint:scripts Found 0 warnings and 0 errors. (317 files, 96 rules)
lint:dashboard Found 0 warnings and 0 errors. (34 files, 95 rules)
lint:src     Found 0 warnings and 0 errors. (167 files, 111 rules)

$ pnpm run build:all
$ tsc -p tsconfig.json        (clean)
$ tsc -p tsconfig.repair.json (clean)
$ tsc -p tsconfig.dashboard.json (clean)

$ node --test test/repair/target-validation.test.ts
ℹ tests 206
ℹ pass 203
ℹ fail 0
ℹ cancelled 0
ℹ skipped 3
ℹ todo 0
```

The 3 skips print the same kernel-capability reason inline: `# runner does not provide delegated user namespaces and Landlock ABI 3+`.

## Production real-behavior proof — direct toolchain run

Both runs used a fresh clone of the real `openclaw/crabpot` repository at `0cb363fdae97a06cc91f96525529cb3907ae20ad`, the exact commit that failed in production, against the compiled `dist/repair/target-validation.js`. Run outside the Crabbox lease because reaching this bug's code path requires a real completed `pnpm install` through `runContainedCommand`'s namespace containment, which this Docker-backed lease can't itself nest (see "Crabbox namespace_setup wall" below for the symmetric confirmation of that limitation).

### RED — unfixed code (`56591f8ebaf3`, the commit immediately before this fix)

```
PROOF_TARGET=openclaw/crabpot@0cb363fdae97a06cc91f96525529cb3907ae20ad
PROOF_STATUS_BEFORE=(clean)
RESULT: prepareTargetToolchain threw: target dependency setup mutated checkout identity: contentTreeSha, status, worktreeSha256
```

This reproduces the exact error from production run [`32812081965`](https://github.com/openclaw/clawsweeper/actions/runs/32812081965).

### GREEN — fixed code (this branch, head `f1cb0dfa666584da87cdf34f80f89fff2b99cc4d`)

```
PROOF_TARGET=openclaw/crabpot@0cb363fdae97a06cc91f96525529cb3907ae20ad
PROOF_STATUS_BEFORE=(clean)
RESULT: prepareTargetToolchain succeeded, no identity mutation error
PROOF_STATUS_AFTER=(clean)
PROOF_LOCKFILE_PRESENT_AFTER=false
```

`git status --porcelain` on the target checkout is empty both before install and after setup completes; no `pnpm-lock.yaml` survives.

## Crabbox `namespace_setup` wall — confirmed symmetric, not masking the bug

Run inside the same `coral-krill` lease against the same `openclaw/crabpot@0cb363fdae97a06cc91f96525529cb3907ae20ad` checkout, on both unfixed and fixed code, to confirm the container's own containment gap is unrelated to this change rather than conveniently avoiding it:

**Unfixed code (`56591f8ebaf3`):**
```
PROOF_TARGET=openclaw/crabpot@0cb363fdae97a06cc91f96525529cb3907ae20ad
PROOF_STATUS_BEFORE=(clean)
PROOF_ERROR_MESSAGE=validation process containment failed: stage=namespace_setup exit=1
```

**Fixed code (this branch):**
```
PROOF_TARGET=openclaw/crabpot@0cb363fdae97a06cc91f96525529cb3907ae20ad
PROOF_ERROR_MESSAGE=validation process containment failed: stage=namespace_setup exit=1
```

Identical failure, identical stage, on both. Neither run reaches far enough into `prepareTargetToolchain` to hit the actual `pnpm install`/identity-check code this fix touches, confirming the wall sits strictly before this bug's own code path and doesn't happen to dodge it in one direction only.
