#!/usr/bin/env bash
set -euo pipefail
# Run inside a disposable Linux container from the candidate checkout.
# The first argument is an archive of origin/main; no GitHub write credentials are needed.
base_archive=${1:?Pass an origin/main tar archive}
output=${2:-/tmp/post-proof-results}
scenario_group=${3:-accepted-baseline}
mkdir -p "$HOME/.local/bin" "$output"
corepack enable --install-directory "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$PATH"
printf 'node=%s\npnpm=%s\n' "$(node --version)" "$(pnpm --version)"
pnpm install --frozen-lockfile
pnpm run build
node docs/proof/post-proof-accepted-baseline/run-proof.ts "$output/candidate" candidate "$scenario_group"
base=$(mktemp -d)
tar -xf "$base_archive" -C "$base"
mkdir -p "$base/docs/proof/post-proof-accepted-baseline"
cp docs/proof/post-proof-accepted-baseline/run-proof.ts "$base/docs/proof/post-proof-accepted-baseline/"
cd "$base"
pnpm install --frozen-lockfile
pnpm run build
node docs/proof/post-proof-accepted-baseline/run-proof.ts "$output/base" base "$scenario_group"
