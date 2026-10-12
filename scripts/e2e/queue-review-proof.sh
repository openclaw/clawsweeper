#!/usr/bin/env bash
set -euo pipefail
archive=${1:?Pass the read-only v0.3.0 git archive}
# Both runs use one fresh candidate build in a disposable container.
bash scripts/e2e/queue-review-identity.sh
npm install --prefix /tmp/queue-proof-pnpm --ignore-scripts --no-audit --no-fund pnpm@10.33.2
mkdir -p /tmp/queue-proof-stable-cache
# Hydrate the pinned stable lockfile before the upgrade driver isolates its environment.
tar -xf "$archive" -C /tmp/queue-proof-stable-cache
stable_pnpm=/tmp/queue-proof-pnpm/node_modules/.bin/pnpm
"$stable_pnpm" --dir /tmp/queue-proof-stable-cache fetch --store-dir /tmp/queue-proof-stable-store
STABLE_PNPM_BIN="$stable_pnpm" STABLE_PNPM_STORE_DIR=/tmp/queue-proof-stable-store \
  node scripts/e2e/queue-review-upgrade.mjs "$archive" /tmp/queue-review-upgrade
