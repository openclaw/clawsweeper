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

echo "PROOF_PHASE=operator"
node --test --experimental-strip-types test/exact-review-dead-letter-operator.test.ts

echo "PROOF_PHASE=content"
sha256sum \
  docs/proof/operator-skip-taxonomy/behavior-contract.md \
  docs/proof/operator-skip-taxonomy/run-proof.sh \
  scripts/exact-review-dead-letter-operator.mjs \
  test/exact-review-dead-letter-operator.test.ts
corepack pnpm exec oxfmt --check \
  docs/proof/operator-skip-taxonomy/behavior-contract.md \
  docs/proof/operator-skip-taxonomy/red-green.md \
  scripts/exact-review-dead-letter-operator.mjs \
  test/exact-review-dead-letter-operator.test.ts
echo "PROOF_RESULT=pass"
