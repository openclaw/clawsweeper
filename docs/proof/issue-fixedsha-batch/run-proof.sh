#!/usr/bin/env bash
set -euo pipefail

expected_head="${1:?expected head is required}"
actual_head="$(git rev-parse HEAD 2>/dev/null || true)"
if test -n "$actual_head"; then
  test "$actual_head" = "$expected_head"
else
  actual_head="$expected_head"
  echo "workspace_mode=raw-sync-no-git-metadata"
fi

export CI=1
export PNPM_HOME="$HOME/.local/bin"
mkdir -p "$PNPM_HOME"
export PATH="$PNPM_HOME:$PATH"
if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable --install-directory "$PNPM_HOME" >/dev/null 2>&1 || true
fi
if ! command -v pnpm >/dev/null 2>&1; then
  npm install -g --prefix "$HOME/.local" pnpm@11.10.0 >/dev/null
fi
if ! command -v jq >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq jq >/dev/null
fi

echo "tested_head=$actual_head"
echo "node_version=$(node --version)"
echo "pnpm_version=$(pnpm --version)"
echo "jq_version=$(jq --version)"

pnpm install --frozen-lockfile
pnpm run build

echo "CRABBOX_PHASE:behavior"
node --test test/fixed-sha-pull-resolution.test.ts test/review-close-policy.test.ts

echo "CRABBOX_PHASE:full-gate"
pnpm run check
