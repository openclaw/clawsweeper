# Command-ack convergence equivalence proof

This proof extracts the command-ack parsing and convergence implementations
from `origin/main` in `update-command-status.ts`, `comment-router-core.ts`, and
`comment-router.ts`. Representative marker, status-scope, status-priority,
updated-time, created-time, and numeric-id tie cases are evaluated against the
new shared helper.

Run after `pnpm run build:repair`:

```sh
node docs/proof/repair-duplication-merges/merge-4/run-proof.mjs
```

The checked-in result is in `artifacts/equivalence.json`. The harness is
deterministic and performs no GitHub, network, queue, workflow, or production
mutation.
