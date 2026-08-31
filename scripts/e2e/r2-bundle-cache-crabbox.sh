#!/usr/bin/env bash
set -euo pipefail

expected_head="${1:-}"
expected_tree="${2:-}"
if ! [[ "$expected_head" =~ ^[0-9a-f]{40}$ ]] || ! [[ "$expected_tree" =~ ^[0-9a-f]{40}$ ]]; then
  echo "expected verified commit and tree SHA arguments" >&2
  exit 2
fi

proof_root="$(mktemp -d)"
proof_output=".artifacts/r2-bundle-cache/proof.json"
worker_log=".artifacts/r2-bundle-cache/wrangler.log"
worker_pid=""
cleanup() {
  if [ -n "$worker_pid" ]; then
    kill "$worker_pid" 2>/dev/null || true
    wait "$worker_pid" 2>/dev/null || true
  fi
  rm -rf "$proof_root"
}
trap cleanup EXIT

mkdir -p "$(dirname "$proof_output")"
echo CRABBOX_PHASE:install
sudo corepack enable
missing_tools=()
command -v curl >/dev/null || missing_tools+=(curl)
command -v jq >/dev/null || missing_tools+=(jq)
if [ "${#missing_tools[@]}" -gt 0 ]; then
  sudo apt-get update
  sudo apt-get install -y "${missing_tools[@]}"
fi
pnpm install --frozen-lockfile
echo CRABBOX_PHASE:build
pnpm run build:all

echo CRABBOX_PHASE:behavior
npx --yes wrangler@4.127.1 dev \
  --config dashboard/wrangler.toml \
  --local \
  --persist-to "$proof_root" \
  --port 8799 \
  --var CLAWSWEEPER_WEBHOOK_SECRET:loopback-hmac-placeholder \
  --log-level error \
  --show-interactive-dev-session=false \
  >"$worker_log" 2>&1 &
worker_pid=$!

ready=false
for _ in $(seq 1 60); do
  if curl --silent --show-error --fail http://127.0.0.1:8799/api/health >/dev/null; then
    ready=true
    break
  fi
  sleep 1
done
if [ "$ready" != "true" ]; then
  cat "$worker_log" >&2
  exit 1
fi

R2_BUNDLE_CACHE_WORKER_URL=http://127.0.0.1:8799 \
R2_BUNDLE_CACHE_WEBHOOK_SECRET=loopback-hmac-placeholder \
R2_BUNDLE_CACHE_PERSIST_TO="$proof_root" \
node scripts/e2e/r2-bundle-cache.mjs >"$proof_output"

jq -e '
  .r2.semantics == "wrangler-dev-local" and
  .first.source == "github" and .first.githubArtifactRequests == 1 and
  .second.source == "r2" and .second.githubArtifactRequests == 0 and
  .first.digest == .second.digest and
  .missingFallback.source == "github" and .missingFallback.githubArtifactRequests == 1 and
  .leaseMismatch.source == "github" and .leaseMismatch.githubArtifactRequests == 1 and
  .counted.repeatBefore == 1 and .counted.repeatAfter == 0
' "$proof_output" >/dev/null

jq --arg head "$expected_head" --arg tree "$expected_tree" \
  '. + {git: {head: $head, tree: $tree, catFileCrossCheck: true}}' \
  "$proof_output" >"${proof_output}.tmp"
mv "${proof_output}.tmp" "$proof_output"
cat "$proof_output"
echo CRABBOX_PHASE:check
pnpm run check
