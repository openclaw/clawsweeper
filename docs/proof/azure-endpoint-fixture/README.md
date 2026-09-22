# Azure endpoint fixture admission proof

The exact synthetic userinfo URL in Crabbox's endpoint-rejection test was not yet in trusted fixture policy, so the normal review input scan refused before model execution. The change adds one URI/PLAIN attribution with exact Raw/RawV2 digest, complete source-line digest, path and file mode. The static policy validator recognizes that exact test path; classification still requires every identity and source witness.

The fixture appears unchanged in base blob `903bf2f5ba35048a1a2142c5173eacf93e8d152e` and head blob `9e2499dd540bda2f69bd6ea2afd4b804bde6da03`, at line 287 of `internal/providers/azuredynamicsessions/client_test.go`. It is a quoted negative case in `TestAzureDynamicSessionsEndpointRejectsUnsafeTokenDestinations`, whose assertion requires rejection. Its synthetic userinfo is not an Azure credential. The hostname uses an Azure service suffix: classification relies on this exact reviewed test context, not a reserved-host heuristic.

## Real scanner comparison

On macOS with Node 24.21.0, the unchanged trusted host at `efd9be863116673997c5935ba4c06321a3f122c8` refused the complete committed range with `literal_not_reviewed`. The candidate admitted that same range through `scanAgentInput`, yielding seven reviewed-fixture notices covering sixteen finding references. Both used checksum-qualified TruffleHog 3.97.4 with normal verification, a controlled nonsecret prompt, and no model execution.

Run against a checkout containing the exact commits after building the host:

```sh
node docs/proof/azure-endpoint-fixture/run-proof.mjs \
  /path/to/crabbox \
  226db96ab9beb6988f2e8601a751dd7e19d96367 \
  f0950d96ead0e2feaf1ca10285a874e5ab06cc97 \
  /private/evidence/azure-fullrange.json
```

The added fixture participates in the existing mutation table: altered literal or line, path, mode, worktree role, decoder, verified status, extra occurrence, mixed references, duplicate native record and incomplete scanner completion are rejected. Existing fixtures now also explicitly test absent completion records.

This proof scans all changed committed source material through the production admission owner, not only the newly qualified blob. It does not establish hosted review completion: that workflow must independently scan its own source, prompt and schema. No target source was changed to evade scanning, and no detector, verification or completion setting was weakened.

## Validation

The TypeScript main and repair builds completed. The three focused scanner suites passed all 424 tests in a credential-free environment with network access restricted to loopback, followed by successful documentation, formatting, lint and diff checks. An initial broader-suite attempt lacked the repair build artifact; after building it, the same suite passed. No finding required relaxing an admission rule.
