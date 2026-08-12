#!/usr/bin/env bash
set -euo pipefail

proof_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "$proof_dir" rev-parse --show-toplevel)"
cd "$repo_root"

export CI=1
export WRANGLER_SEND_METRICS=false

corepack enable
pnpm install --frozen-lockfile
printf 'PROOF_HEAD=%s\n' "$(git rev-parse HEAD)"
printf 'PROOF_NODE=%s\n' "$(node --version)"
printf 'PROOF_PNPM=%s\n' "$(pnpm --version)"
printf 'CRABBOX_PHASE:build\n'
pnpm run build:dashboard
printf 'CRABBOX_PHASE:worker-proof\n'
node "$proof_dir/run-proof.mjs"
