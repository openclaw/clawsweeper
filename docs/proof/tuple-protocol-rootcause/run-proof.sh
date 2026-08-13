#!/usr/bin/env bash
set -euo pipefail

expected_head=${1:?expected committed head argument is required}
proof_prefix=/tmp/tuple-protocol-proof-prefix
proof_repo_root=$(cd "$(dirname "$0")/../.." && pwd)

cd "$proof_repo_root"

echo "PROOF_PHASE=environment"
echo "provider=local-container"
echo "image=node:24-bookworm"
echo "head=$expected_head"
node --version
npm --version

echo "PROOF_PHASE=corepack"
mkdir -p "$proof_prefix/bin"
npm install --global --prefix "$proof_prefix" corepack@0.35.0
export PATH="$proof_prefix/bin:$PATH"
corepack enable --install-directory "$proof_prefix/bin"
corepack pnpm --version

echo "PROOF_PHASE=install"
corepack pnpm install --frozen-lockfile

echo "PROOF_PHASE=build"
corepack pnpm run build:all

echo "PROOF_PHASE=behavior"
node --test \
  test/dashboard-worker-publication-lifecycle.test.ts \
  test/exact-review-dead-letter-operator.test.ts \
  test/exact-review-publication-batches.test.ts

echo "PROOF_PHASE=full_gate"
corepack pnpm run check

echo "PROOF_PHASE=content"
sha256sum \
  dashboard/exact-review-queue.ts \
  docs/proof/tuple-protocol-rootcause/README.md \
  docs/proof/tuple-protocol-rootcause/behavior-contract.md \
  docs/proof/tuple-protocol-rootcause/red-green.md \
  docs/proof/tuple-protocol-rootcause/run-proof.sh \
  scripts/exact-review-dead-letter-operator.mjs \
  test/dashboard-worker-publication-lifecycle.test.ts \
  test/exact-review-dead-letter-operator.test.ts
corepack pnpm exec oxfmt --check \
  dashboard/exact-review-queue.ts \
  docs/proof/tuple-protocol-rootcause/README.md \
  docs/proof/tuple-protocol-rootcause/behavior-contract.md \
  docs/proof/tuple-protocol-rootcause/red-green.md \
  docs/proof/tuple-protocol-rootcause/run-proof.sh \
  scripts/exact-review-dead-letter-operator.mjs \
  test/dashboard-worker-publication-lifecycle.test.ts \
  test/exact-review-dead-letter-operator.test.ts
echo "PROOF_RESULT=pass"
