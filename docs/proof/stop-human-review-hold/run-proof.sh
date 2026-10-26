#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
base=8034e33f987c1b8e39eecbc137e9e7de03baaed2
output="${STOP_PROOF_PACKAGE_OUTPUT:-.artifacts/f1-stop-hold}"
mkdir -p "$output"
output="$(realpath "$output")"
node --version > "$output/runtime.txt"
pnpm --version >> "$output/runtime.txt"
git rev-parse HEAD HEAD^{tree} >> "$output/runtime.txt"
git diff --binary HEAD > "$output/candidate.patch"
sha256sum src/repair/comment-router.ts scripts/e2e/comment-router-stop-loopback.mjs > "$output/source-sha256.txt"
pnpm install --frozen-lockfile > "$output/install.log" 2>&1
pnpm run build:node > "$output/build.log" 2>&1
STOP_PROOF_OUTPUT="$output/candidate" node scripts/e2e/comment-router-stop-loopback.mjs > "$output/candidate-summary.json"
base_root="$output/base-source"
mkdir -p "$base_root"
git archive "$base" | tar -xf - -C "$base_root"
cp scripts/e2e/comment-router-stop-loopback.mjs "$base_root/scripts/e2e/comment-router-stop-loopback.mjs"
(
  cd "$base_root"
  pnpm install --frozen-lockfile > "$output/base-install.log" 2>&1
  pnpm run build:node > "$output/base-build.log" 2>&1
  STOP_PROOF_OUTPUT="$output/baseline" STOP_PROOF_BASELINE=1 node scripts/e2e/comment-router-stop-loopback.mjs > "$output/baseline-summary.json"
)
node --test test/repair/comment-router-stop.test.ts test/repair/comment-router-action-ledger.test.ts test/repair/comment-router-throttle-resilience.test.ts test/repair/comment-router-core.test.ts > "$output/focused-tests.tap" 2>&1
cat "$output/baseline-summary.json" "$output/candidate-summary.json"
