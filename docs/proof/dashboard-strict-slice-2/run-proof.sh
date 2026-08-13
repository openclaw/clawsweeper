#!/usr/bin/env bash
set -euo pipefail

expected_head=${1:?expected committed head argument is required}
proof_rc=0
trap 'proof_rc=$?; echo "PROOF_RC=$proof_rc"' EXIT

proof_head="$(git rev-parse HEAD)"
proof_base="$(git merge-base HEAD origin/main)"
test "$proof_head" = "$expected_head"
test -z "$(git status --porcelain --untracked-files=no)"
git cat-file -e "$proof_head^{commit}"
git cat-file -e "$proof_base^{commit}"
echo "PROOF_RECEIPT=COMMITTED"
echo "PROOF_HEAD=$proof_head"
echo "PROOF_MERGE_BASE=$proof_base"

corepack enable
pnpm install --frozen-lockfile
pnpm run check:dashboard-strict
node --test test/check-dashboard-strict.test.ts
pnpm run check
node docs/proof/dashboard-strict-slice-2/run-proof.mjs
