#!/usr/bin/env bash
set -euo pipefail

expected_head=${1:?expected committed head argument is required}
expected_base=${2:?expected origin/main base argument is required}
[[ "$expected_head" =~ ^[0-9a-f]{40}$ ]]
[[ "$expected_base" =~ ^[0-9a-f]{40}$ ]]

export PATH="$HOME/.local/bin:$PATH"
mkdir -p "$HOME/.local/bin"

echo "PROOF_PHASE=environment"
echo "provider=local-container"
echo "image=node:24-bookworm"
echo "head=$expected_head"
echo "base=$expected_base"
if git rev-parse HEAD >/dev/null 2>&1; then
  test "$(git rev-parse HEAD)" = "$expected_head"
  echo "head_attestation=local_git"
else
  echo "head_attestation=explicit_argument_with_content_hashes"
fi
node --version
npm --version

echo "PROOF_PHASE=corepack"
npm install --global --prefix "$HOME/.local" corepack@0.35.0
corepack enable --install-directory "$HOME/.local/bin"
corepack pnpm --version

echo "PROOF_PHASE=install"
corepack pnpm install --frozen-lockfile

echo "PROOF_PHASE=build"
corepack pnpm run build:all

echo "PROOF_PHASE=focused-router-test"
node --test \
  --test-name-pattern='canonical record reads accept distinct webhook and operator secrets' \
  test/dashboard-worker-publication-lifecycle.test.ts

echo "PROOF_PHASE=real-worker"
OPERATOR_RECORD_READ_AUTH_PROOF_OUTPUT=.artifacts/operator-record-read-auth/behavior-report.json \
  node docs/proof/operator-record-read-auth/run-proof.mjs "$expected_head" "$expected_base"

echo "PROOF_PHASE=dashboard-strict"
corepack pnpm run check:dashboard-strict

echo "PROOF_PHASE=full-gate"
corepack pnpm run check

echo "PROOF_PHASE=content"
sha256sum \
  dashboard/worker.ts \
  docs/proof/operator-record-read-auth/behavior-contract.md \
  docs/proof/operator-record-read-auth/red-green.md \
  docs/proof/operator-record-read-auth/run-proof.mjs \
  docs/proof/operator-record-read-auth/run-proof.sh \
  test/dashboard-worker-publication-lifecycle.test.ts
if git rev-parse HEAD >/dev/null 2>&1; then
  test -z "$(git status --porcelain)"
else
  echo "source_status=git_metadata_unavailable_after_linked-worktree_sync"
fi
echo "PROOF_RESULT=pass"
