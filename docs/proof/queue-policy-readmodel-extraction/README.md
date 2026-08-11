# Queue policy and read-model extraction proof

## Claim

Moving exact-review decision/supersession policy into
\`dashboard/exact-review-decision.ts\` and queue statistics/Bay projection into
\`dashboard/exact-review-read-model.ts\` changes no queue decisions or public
dashboard responses.

## Exercised surface

- \`moved-body-identity.mjs\` parses the merge-base queue source and the
  candidate modules with TypeScript, extracts every moved function body from
  its opening brace through its closing brace, and requires exact byte equality.
- \`run-proof.mjs\` starts the real local Wrangler Worker for merge-base and
  candidate revisions, seeds six review items through the signed
  \`/internal/exact-review/enqueue\` route, then compares normalized
  \`/api/exact-review-queue\` and \`/api/status\` JSON bytes.
- Both revisions use independent SQLite-backed Durable Object state.

The committed \`moved-body-identity.json\` is the source-identity result. Runtime
artifacts are written to the ignored \`artifacts/\` directory.

## Run

From the repository root on Node 24 or newer:

\`\`\`bash
docs/proof/queue-policy-readmodel-extraction/run-proof.sh
\`\`\`

The script prints \`PROOF_RC=0\` after both routes compare byte-identically.

## Limits and OpenClaw Bay impact

This is a local real-Worker proof over synthetic pending reviews and a
deterministic loopback GitHub error stub. It does not contact GitHub, publish
records, acquire review leases, or mutate production.

OpenClaw Bay is unaffected. This is an ownership-only move: Bay constants,
projection logic, response schema, and observer-only control boundary are
byte-identical.
