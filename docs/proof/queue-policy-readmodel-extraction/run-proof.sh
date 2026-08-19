#!/usr/bin/env bash
set -euo pipefail

proof_rc=0
trap 'proof_rc=$?; echo "PROOF_RC=$proof_rc"' EXIT

corepack enable
pnpm install --frozen-lockfile
node docs/proof/queue-policy-readmodel-extraction/moved-body-identity.mjs
node docs/proof/queue-policy-readmodel-extraction/run-proof.mjs
