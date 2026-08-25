# Behavior contract

**Claim**: `prepareTargetToolchain` no longer throws `target dependency setup mutated checkout identity` for a target repository with no committed `pnpm-lock.yaml`, and the checkout is left exactly as it started (no stray lockfile). A tracked or pre-existing untracked lockfile is still restored/verified exactly as before, real mutations still fail closed.

**Exercised surface**: `preparePnpmToolchain` / `assertValidationSourceIdentity` in `src/repair/target-validation.ts`, reached through the public `prepareTargetToolchain` entrypoint, the same install path every pnpm-based repair and automerge run goes through.

**Scenario / fixture**:
1. Unit fixtures in `test/repair/target-validation.test.ts`:
   - `dependency setup removes a lockfile pnpm materializes where none existed`: no lockfile before setup, a mocked pnpm writes one during install, asserts it does not survive setup.
   - `pnpm lockfile fallback restores a pre-existing untracked lockfile exactly`: a pre-existing untracked lockfile survives the outdated-lockfile fallback path byte-for-byte.
   - `dependency setup rejects tracked source mutation`: an unrelated tracked-file mutation during install still throws, confirming the guard stays fail-closed outside the specific absent-lockfile case.
2. Production real-behavior fixture: a fresh clone of the actual `openclaw/crabpot` repository at `0cb363fdae97a06cc91f96525529cb3907ae20ad`, the exact commit that failed in production, no dependencies, no committed lockfile, run through `prepareTargetToolchain` with `installTargetDeps: true`.

**Command and environment**: Docker-backed Crabbox `local-container` lease for the focused unit suite and static gates (node:24-bookworm, Node v24.19.0, pnpm 11.10.0). The production real-behavior fixture (RED/GREEN comparison) was run directly against the real toolchain outside that lease, see "Limits" below for why. See `run-proof.sh` for the exact commands and `receipt.json` for full environment binding.

**Observable result**:
- Unit fixtures: all pass (`node --test test/repair/target-validation.test.ts` inside the Crabbox lease, 206 tests, 203 passing, 3 skipped for a documented kernel-capability gate, 0 failing).
- Production fixture, unfixed code (`56591f8ebaf3`, the commit immediately before this fix): throws `target dependency setup mutated checkout identity: contentTreeSha, status, worktreeSha256` (RED, reproduces production run [`32812081965`](https://github.com/openclaw/clawsweeper/actions/runs/32812081965) exactly).
- Production fixture, fixed code (this branch): returns without throwing, and `git status --porcelain` on the target checkout is empty both before install and after setup completes, no `pnpm-lock.yaml` left behind (GREEN).

**Artifact / trace**: `red-green.md`, `receipt.json`.

**Limits**:
- ClawSweeper's own Linux process-containment stage (`namespace_setup`, reached inside `runContainedCommand` before the actual `pnpm install` this bug lives in) fails outright inside this Docker-backed Crabbox `local-container` lease, on both unfixed and fixed code identically (confirmed both ways, see `red-green.md`), because the container doesn't have delegated user namespaces / Landlock ABI 3+ available to nest further inside Docker. That's the same kernel-capability gap the focused suite's 3 skipped tests hit. Since this bug's own reproduction requires a real `pnpm install` to actually run and complete (unlike the unrelated `deprecated`-field fix's proof, which failed earlier in the pipeline, before containment setup), the RED/GREEN production comparison for *this* bug can't be produced inside `local-container` at all here, it was instead run directly against a real toolchain that does have working namespace/Landlock support, using the same real `openclaw/crabpot` commit and the same compiled `dist/repair/target-validation.js` entrypoint. The focused unit suite and static gates, which don't require completing a live namespace-contained install, did run inside the Crabbox lease and are reported above.
- This proof does not run the full `pnpm run check` gate, for the same reason noted in the prior `lockfile-deprecated-field-network-policy` proof (`test:coverage:no-build` needs CI-only secrets); scoped to build, lint, format, the full changed test file, and the production real-behavior proof, per `CONTRIBUTING.md`'s narrowest-meaningful-validation guidance.
- This proof was not produced or reviewed through ClawSweeper's own Codex `/review` loop, that step is GitHub-tooling-side and outside what a contributor can run locally.
