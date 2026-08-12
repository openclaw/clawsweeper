#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"
mkdir -p "$HOME/.local/bin"

echo "PROOF_PHASE=environment"
echo "provider=local-container"
echo "image=node:24-bookworm"
node --version
npm --version

echo "PROOF_PHASE=corepack"
npm install --global --prefix "$HOME/.local" corepack@0.35.0
corepack enable --install-directory "$HOME/.local/bin"
corepack pnpm --version

echo "PROOF_PHASE=install"
corepack pnpm install --frozen-lockfile

echo "PROOF_PHASE=loopback"
node --experimental-strip-types --test \
  --test-name-pattern='dead-letter workflow is manual|scheduled, bounded|serial canonical discovery|serial recovery revalidation|100-target reconciliation|batched canonical discovery|multi-owner reconciliation|valid owner installation|operator previews' \
  test/exact-review-dead-letter-operator.test.ts

echo "PROOF_PHASE=content"
sha256sum \
  .github/workflows/exact-review-dead-letter-operator.yml \
  .github/workflows/exact-review-dead-letter-reconcile.yml \
  dashboard/exact-review-queue.ts \
  dashboard/github-api.ts \
  dashboard/worker.ts \
  scripts/exact-review-dead-letter-operator.mjs \
  scripts/operator-skip-reasons.mjs \
  test/exact-review-dead-letter-operator.test.ts
git diff --check
echo "PROOF_RESULT=pass"
