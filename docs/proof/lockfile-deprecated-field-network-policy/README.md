# Lockfile "deprecated" field misclassified as an unapproved install destination

Production run [`32367984753`](https://github.com/openclaw/clawsweeper/actions/runs/32367984753) (`Execute credited fix artifact` step, 2026-08-20) stopped ClawSweeper's automatic implementation for [openclaw/openclaw#126659](https://github.com/openclaw/openclaw/issues/126659) with `target dependency install destination is not approved: https://github.com`, thrown from `assertApprovedInstallUrl` before any real dependency install was attempted. The issue being worked (Android `location.get` ignoring `maxAgeMs`) has nothing to do with dependency installation; the toolchain-preparation gate itself was misfiring.

`openclaw/openclaw`'s `pnpm-lock.yaml` carries a `packages:` entry for a deprecated transitive dependency, `@aws-sdk/core@3.977.1`, whose `deprecated` field is pnpm's verbatim copy of the npm registry's own deprecation notice for that version:

```yaml
'@aws-sdk/core@3.977.1':
  resolution: {integrity: sha512-...}
  engines: {node: '>=20.0.0'}
  deprecated: |-
    Deprecated due to Document number parsing bug in JSON, see
      https://github.com/aws/aws-sdk-js-v3/issues/8246. Newer version available.
```

That text is free-form maintainer-authored content, never an install source, but `assertStructuredInstallMetadataDestinations` (`src/repair/target-validation.ts`) only exempted the `funding` field from the install-destination URL scan for package records. `deprecated` wasn't exempted, so the GitHub issue link embedded in the deprecation notice tripped the scan and aborted `prepareTargetToolchain` before the fix worker ever ran. This is the same class of false positive fixed narrowly for `integrity` hashes in [#649](https://github.com/openclaw/clawsweeper/pull/649), a different field.

**Fix**: extend the existing package-record exemption to also cover `deprecated`, but narrower than `funding`'s exemption, since npm's registry only ever emits `deprecated` as a plain string (unlike `funding`, which is legitimately a string, object, or array), the exemption requires `typeof entry === "string"`, so a malformed object- or array-shaped `deprecated` field (not a real registry shape) still hits the fail-closed scan. A companion regression test proves a malicious `resolved` URL sitting beside a legitimate `deprecated` string in the same package record is still rejected, the per-field exemption does not widen to sibling fields.

The executable contract is in [`behavior-contract.md`](behavior-contract.md), RED/GREEN evidence is in [`red-green.md`](red-green.md), and [`run-proof.sh`](run-proof.sh) is the Docker-backed Crabbox launcher. [`receipt.json`](receipt.json) binds the head that was actually exercised, `bfda61b0b2520e34569f3797ab4e4089db6f1dd5` (the fix and its tests; this proof directory was added in a later commit on the same branch that changes no tested file, so it postdates that head without invalidating the proof), provider `local-container`, lease `cbx_c6901e89c73a` (`harbor-barnacle`), Docker image `node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584`, the full focused `test/repair/target-validation.test.ts` suite (202 passing, 3 skipped for a documented kernel-capability gate unrelated to this change, 0 failing), clean `format:check`, clean `lint`, clean `build:all`, and a real production-entrypoint run against the actual `openclaw/openclaw@e2f841bf1c1286940e3e89627ec2dc02514d9325` checkout on both the unfixed and fixed code.

**Scope note**: this proof does not run the full `pnpm run check` gate. That gate's `test:coverage:no-build` step exercises `test/sweep-workflow.test.ts`, which requires GitHub Actions-simulation secrets/tokens not available outside CI and fails identically on unmodified `main` in this same container; it is unrelated to the changed surface (`src/repair/target-validation.ts`). Per `CONTRIBUTING.md`'s own guidance to use the narrowest meaningful validation for the changed surface, this proof scopes to build, lint, format, and the full test file the change lives in, plus the production real-behavior proof. This proof was also not produced or reviewed by ClawSweeper's own Codex `/review` loop; that step is GitHub-tooling-side and outside what a contributor can run locally, flagged here rather than silently presented as complete.
