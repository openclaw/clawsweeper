# Closure evidence controlled proof

With the pinned dependencies already installed, run:

```sh
node docs/proof/closure-evidence/run-proof.mjs
```

The fixture exercises the built `apply-decisions` CLI with isolated temporary
reports, plans, closed records, model output, and GitHub transport. It removes
credentials and isolates GitHub auth. Both configured and raw PATH `gh`/`ghx`
calls terminate in a synthetic transport. Unexpected commands,
explicit mutations, implicit payload POSTs, and GraphQL mutations are rejected
before any external dispatch. Four final-effect scenarios additionally admit
only an exact synthetic closeout POST and, for the eligible control, the exact
synthetic PR close command. Their receiver records local state and never
delegates to GitHub. No real GitHub endpoint is contacted.

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

Four additional cases run without dry-run against that recording receiver.
The eligible canonical-covered control must publish one distinct closeout note,
dispatch one final close, and archive its report. A recent human edit to an old
bot-authored comment must keep the item open even after a later bot edit. A new
human comment or current-main drift introduced only after the closeout POST
must prevent the final close and retain the open report. Each case asserts the
exact refusal or retry, stage witnesses, and zero forbidden transport intents.

Results and call traces go to stdout; temporary state is removed. The proof
does not establish semantic source equivalence, model accuracy, or a hosted or
live close. The local receiver demonstrates final-effect guard plumbing;
semantic source equivalence and real GitHub writes remain outside this proof.
