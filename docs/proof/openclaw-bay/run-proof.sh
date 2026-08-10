#!/usr/bin/env bash
set -euo pipefail

export CI=1
export WRANGLER_SEND_METRICS=false

output_dir="${BAY_PROOF_OUTPUT:-.artifacts/openclaw-bay-proof}"
port="${BAY_PROOF_PORT:-8787}"
deps_dir="/tmp/openclaw-bay-playwright"
wrangler_log="/tmp/openclaw-bay-wrangler.log"

rm -rf "$output_dir" "$deps_dir"
mkdir -p "$output_dir" "$deps_dir"

npm install --prefix "$deps_dir" --no-audit --no-fund playwright@1.60.0 >/tmp/openclaw-bay-playwright-install.log 2>&1

npx --yes wrangler@4.107.0 dev \
  --config dashboard/wrangler.toml \
  --local \
  --ip 127.0.0.1 \
  --port "$port" \
  >"$wrangler_log" 2>&1 &
wrangler_pid=$!

cleanup() {
  kill "$wrangler_pid" >/dev/null 2>&1 || true
  wait "$wrangler_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for _ in $(seq 1 90); do
  if curl --fail --silent "http://127.0.0.1:${port}/bay" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$wrangler_pid" >/dev/null 2>&1; then
    cat "$wrangler_log" >&2
    exit 1
  fi
  sleep 1
done

curl --fail --silent --show-error "http://127.0.0.1:${port}/bay" >/dev/null

export PLAYWRIGHT_MODULE="file://${deps_dir}/node_modules/playwright/index.mjs"
export PLAYWRIGHT_CHROMIUM_EXECUTABLE="/ms-playwright/chromium-1223/chrome-linux64/chrome"
export SOURCE_SHA="${BAY_PROOF_SOURCE_SHA:-$(git rev-parse HEAD 2>/dev/null || printf unknown)}"
export BAY_PROOF_OUTPUT="$output_dir"
export BAY_PROOF_PORT="$port"

node docs/proof/openclaw-bay/run-proof.mjs

test -s "$output_dir/trace.zip"
test -s "$output_dir/playwright-proof-storyboard.jpg"
test -s "$output_dir/playwright-proof-report.html"
test -s "$output_dir/proof-summary.json"
