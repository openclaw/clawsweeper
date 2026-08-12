# Durable command intake proof receipt

The pinned-main/candidate comparison passed on the repository-resolved Crabbox
backend.

- Tested candidate: `10f574b39c62cbc99a972967bda4e529cb15784e`
- Baseline: `bd869542a3a820c4d3d5fb44bcf2fc553f8f3468`
- Provider: `aws`
- Lease: `cbx_63aaf1aeefab` (`golden-shrimp-4f6a`)
- Run: `run_ebdd0e751613`
- Machine: `c7a.8xlarge`, Linux (`ubuntu:26.04` resolved target)
- Result: `comparison_pass=true`; exit code 0
- Cleanup: both inner Wrangler process groups confirmed SIGTERM completion
  before persistence inspection. Crabbox heartbeat trouble left the outer lease
  visible after the successful command, so it was explicitly released and
  verified absent from the owned-lease inventory.

The baseline wrote one optimistic acknowledgement and reaction, then returned
HTTP 500 when its repository dispatch was throttled. It had no durable command
schema or intake row. The candidate returned HTTP 202 before acknowledgement,
then retained one pending intake/receipt when its deferred source-comment read
was throttled. SQLite inspection found all four required tables, which proves
the ExactReviewQueue Durable Object was instantiated.

Command:

```sh
PROOF_BASE_SHA=bd869542a3a820c4d3d5fb44bcf2fc553f8f3468 \
PROOF_CANDIDATE_SHA=10f574b39c62cbc99a972967bda4e529cb15784e \
PROOF_OUTPUT=.artifacts/durable-command-intake \
node docs/proof/durable-command-intake/run-proof.mjs
```

The successful run used Crabbox `--no-hydrate` because this repository's pinned
`pnpm/action-setup` step is not supported by the wrapper's local Actions
hydrator. That workaround did not change provider selection; the proof script
requires only the raw image's Node 24, Git, and npx toolchain.

Limits: the GitHub API was a loopback synthetic listener, and no live credential
or production mutation was used. The proof covers command acceptance, throttled
retry durability, Worker boot isolation, and DO schema instantiation; it does
not exercise executor completion or final public review publication.
