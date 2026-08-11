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

## Crabbox provenance

The proof in this directory passed unchanged at reviewed head
\`50a3749343b28b045e02722010aa91893c63a9f1\` inside a Docker-backed Crabbox
\`local-container\`. The run used a clean
\`--fresh-pr openclaw/clawsweeper#1124 --no-hydrate\` checkout, Crabbox CLI
\`0.38.3-5-g2a79805d\`, image \`node:24-bookworm\`, Docker 29.4.0 via
OrbStack, and lease \`cbx_f28414ea4f87\` (\`coral-lobster-07c4\`). Corepack
and checksum-verified jq 1.8.1 were installed under the unprivileged container
user's \`$HOME/.local/bin\`.

The full \`pnpm run check\` and the proof script passed. Crabbox reported
\`run_status: succeeded\`, \`exit_code: 0\`, and \`lease_stopped: true\`, with
9.0 seconds of checkout/sync, 299.5 seconds of command time, and 308.5 seconds
total. The verbatim proof result was \`PROOF_RC=0\`.

See the
[machine-readable container provenance](artifacts/crabbox-local-container-provenance.json)
and [redacted container stdout](artifacts/crabbox-local-container-stdout.log).

## Limits and OpenClaw Bay impact

This is a local real-Worker proof over synthetic pending reviews and a
deterministic loopback GitHub error stub. It does not contact GitHub, publish
records, acquire review leases, or mutate production.

The Crabbox run does not broaden those \`run-proof.sh\` limits. Its receipt
adds current-head, clean-checkout, container-image, toolchain, lease, timing,
and cleanup provenance for the same bounded scenario.

OpenClaw Bay is unaffected. This is an ownership-only move: Bay constants,
projection logic, response schema, and observer-only control boundary are
byte-identical.
