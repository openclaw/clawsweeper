#!/usr/bin/env bash
set -euo pipefail

proof_rc=0
trap 'proof_rc=$?; echo "PROOF_RC=$proof_rc"' EXIT

test -z "$(git status --porcelain --untracked-files=no)"
git cat-file -e HEAD^{commit}
echo "PROOF_RECEIPT=COMMITTED"
echo "PROOF_HEAD=$(git rev-parse HEAD)"

corepack enable
pnpm install --frozen-lockfile
node docs/proof/dashboard-strict-slice-1/run-proof.mjs
