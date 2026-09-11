# Fresh replacement branch proof

Status: active validation recipe. Owner: repair execution and target Git plumbing.
Source: `checkoutRecoverableReplacementBranch` in the repair executor and the
existing target materialization/branch-switch helpers. Update when their
head, clean-checkout or branch-attachment contracts change.

The reported worker failure occurs when the target base advances between clone
and fetch. Fetch updates `origin/main`, not the checked-out HEAD. The fresh
replacement path previously asked the branch-switch guard to accept the fetched
head without first materializing it; the guard correctly refused.

```sh
pnpm run build:node
node --test test/repair/replacement-branch-head.test.ts
node docs/proof/replacement-branch-head/run-proof.mjs 6bc31fc32aee440a3a2ae2a75431df508ef6c563
```

The proof creates real local Git origins and clones. The origin advances after
clone, and the clone fetches the new base while retaining its old HEAD. It
executes the actual executor control-flow function taken from the built artifact
with the real isolated Git materialization and branch-switch owners. Only
remote PR/branch discovery is replaced with the already-established fresh-branch
result; no model or GitHub publication is executed.

The baseline reproduces the exact head-mismatch error. The candidate attaches
the replacement branch to the fetched base with matching clean contents. Dirty
source remains untouched and rejected, and an injected head change between
materialization and attachment still trips the original guard. The receipt
records runtime, executor source digest and observations under `.artifacts/`.

Limits: this is controlled repair-checkout integration, not a full model-driven
production repair. Dispatch the original job on current `main` after landing;
rerunning the old Actions attempt would retain its old source revision.
Bay and its observer-only public contracts are unaffected.
