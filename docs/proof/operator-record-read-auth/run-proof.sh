#!/usr/bin/env bash
set -euo pipefail

expected_head=${1:?expected committed head argument is required}

export PATH="$HOME/.local/bin:$PATH"
mkdir -p "$HOME/.local/bin"

echo "PROOF_PHASE=environment"
echo "provider=local-container"
echo "image=node:24-bookworm"
echo "head=$expected_head"
test "$(git rev-parse HEAD)" = "$expected_head"
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
  node docs/proof/operator-record-read-auth/run-proof.mjs "$expected_head"

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
test -z "$(git status --porcelain)"
echo "PROOF_RESULT=pass"
