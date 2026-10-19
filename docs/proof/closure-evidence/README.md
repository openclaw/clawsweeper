# Closure evidence controlled proof

With the pinned dependencies already installed, run:

```sh
node docs/proof/closure-evidence/run-proof.mjs
```

The fixture exercises the built `apply-decisions` CLI with isolated temporary
reports, plans, closed records, model output, and GitHub transport. It removes
credentials and isolates GitHub auth. Both configured and raw PATH `gh`/`ghx`
calls terminate in a read-only synthetic transport. Unexpected commands,
explicit mutations, implicit payload POSTs, and GraphQL mutations are rejected
before any external dispatch. No real GitHub endpoint is contacted.

It runs `pnpm run build:node` with an environment allowlist and Corepack network
disabled. The receipt binds every tracked and untracked source input, every
built file, and the fixture helpers. It checks these manifests remain unchanged
through the build and proof. The agent runner is pinned to the fake Codex binary.

All four product-scope reasons run without dry-run, with relevant flags enabled
and the `all` reason allowlist. They must reach the exact manual-decision
refusal, retain their proposal, and emit zero write intents. Obsolete-fix cases
retain path-only nominations, useful regression-test residuals, and current-main
drift. A reachable canonical-covered dry-run control proves the coverage stage
and eventual close path are connected.

Results and call traces go to stdout; temporary state is removed. The proof
does not establish semantic source equivalence, model accuracy, or a hosted or
live close. Separate review and tests cover packet validation, source/head and
canonical binding, human activity, and final mutation-boundary rechecks.
