#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$HOME/.local/bin"
corepack enable --install-directory "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$PATH"
pnpm install --frozen-lockfile
pnpm run build:all
node scripts/e2e/queue-review-identity.mjs run /tmp/queue-review-identity
