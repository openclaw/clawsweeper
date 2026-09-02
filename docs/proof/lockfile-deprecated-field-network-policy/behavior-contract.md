# Behavior contract

**Claim**: `prepareTargetToolchain` no longer throws `target dependency install destination is not approved` when a target repository's lockfile contains a `deprecated` package-record field whose text embeds a URL, while a malicious `resolved`/`tarball` URL anywhere in the same lockfile, including beside an exempt `deprecated` string in the same package record, is still rejected.

**Exercised surface**: `assertStructuredInstallMetadataDestinations` / `assertManifestDependencyDestinations` / `assertApprovedInstallUrl` in `src/repair/target-validation.ts`, reached through the public `prepareTargetToolchain` entrypoint.

**Scenario / fixture**:
1. Unit fixtures in `test/repair/target-validation.test.ts`:
   - a `pnpm-lock.yaml` package record for `@aws-sdk/core@3.977.1` with the real `deprecated` text from the production lockfile (must not throw)
   - a package-lock.json dependency literally named `deprecated` holding a `resolved` install URL (must still throw, exemption is scoped to `context === "package-record"`, not dependency names)
   - a `deprecated` field whose value is an object, not a string (must still throw, exemption requires `typeof entry === "string"`)
   - a package record with both an exempt `deprecated` string (containing a URL) and a malicious `resolved` URL (must still throw on `resolved`, exemption does not widen to sibling fields)
2. Production real-behavior fixture: a fresh clone of the actual `openclaw/openclaw` repository at its current head, which carries the real triggering `deprecated` field, run through `prepareTargetToolchain` with `installTargetDeps: true`.

**Command and environment**: Docker-backed Crabbox `local-container` lease, `node:24-bookworm`, Node v24.19.0, pnpm 11.10.0, corepack-pinned. See `run-proof.sh` for the exact commands. Full detail in `receipt.json`.

**Observable result**:
- Unit fixtures: all pass (`node --test test/repair/target-validation.test.ts` — 202 passing, 3 skipped for an unrelated documented kernel-capability gate, 0 failing).
- Production fixture, unfixed code: throws `target dependency install destination is not approved: https://github.com` (RED, reproduces the exact production failure).
- Production fixture, fixed code: does not throw that error; execution proceeds past the network-policy stage into later toolchain setup (GREEN).

**Artifact / trace**: `red-green.md`, `receipt.json`.

**Limits**:
- The production fixture proof uses a short (8s) install/setup timeout budget, since a full dependency install and validation run is out of scope for this proof, the fixed run does proceed into a later stage (`namespace_setup`) that is itself gated by a kernel capability (delegated user namespaces / Landlock ABI 3+) this container doesn't have; that is the same gate the 3 skipped unit tests hit, unrelated to this change, and confirmed identical on unfixed code before ever reaching the network-policy stage.
- This proof does not run the full `pnpm run check` gate (see README "Scope note"), and was not produced or reviewed through ClawSweeper's own Codex `/review` loop.
