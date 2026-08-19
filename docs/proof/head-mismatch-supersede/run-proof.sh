#!/usr/bin/env bash
set -euo pipefail

expected_head=${1:?expected committed head argument is required}

export PATH="$HOME/.local/bin:$PATH"
mkdir -p "$HOME/.local/bin"

echo "PROOF_PHASE=environment"
echo "provider=local-container"
echo "image=node:24-bookworm"
echo "head=$expected_head"
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

echo "PROOF_PHASE=behavior"
node --test \
  test/exact-review-dead-letter-operator.test.ts \
  test/dashboard-worker-queue-runtime.test.ts

echo "PROOF_PHASE=content"
sha256sum \
  dashboard/exact-review-queue.ts \
  docs/proof/head-mismatch-supersede/behavior-contract.md \
  docs/proof/head-mismatch-supersede/run-proof.sh \
  scripts/exact-review-dead-letter-operator.mjs \
  test/dashboard-worker-queue-runtime.test.ts \
  test/exact-review-dead-letter-operator.test.ts
corepack pnpm exec oxfmt --check \
  dashboard/exact-review-queue.ts \
  docs/proof/head-mismatch-supersede/behavior-contract.md \
  docs/proof/head-mismatch-supersede/red-green.md \
  docs/proof/head-mismatch-supersede/run-proof.sh \
  docs/scheduler.md \
  scripts/exact-review-dead-letter-operator.mjs \
  test/dashboard-worker-queue-runtime.test.ts \
  test/exact-review-dead-letter-operator.test.ts
echo "PROOF_RESULT=pass"
