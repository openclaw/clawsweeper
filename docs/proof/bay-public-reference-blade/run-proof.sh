#!/usr/bin/env bash
set -euo pipefail

export CI=1
export WRANGLER_SEND_METRICS=false

output_dir="${BLADE_PROOF_OUTPUT:-.artifacts/bay-public-reference-blade}"
port="${BLADE_PROOF_PORT:-8787}"
deps_dir="/tmp/bay-public-reference-blade-playwright"
wrangler_log="/tmp/bay-public-reference-blade-wrangler.log"

rm -rf "$output_dir" "$deps_dir"
mkdir -p "$output_dir" "$deps_dir"

npm install --prefix "$deps_dir" --no-audit --no-fund playwright@1.60.0 >/tmp/bay-public-reference-blade-playwright-install.log 2>&1

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
    tail -n 80 "$wrangler_log" >&2
    exit 1
  fi
  sleep 1
done

curl --fail --silent --show-error "http://127.0.0.1:${port}/bay" >/dev/null

export PLAYWRIGHT_MODULE="file://${deps_dir}/node_modules/playwright/index.mjs"
browser_executable="/ms-playwright/chromium-1223/chrome-linux64/chrome"
if [[ ! -x "$browser_executable" ]]; then
  browser_executable="$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)"
fi
if [[ -z "$browser_executable" || ! -x "$browser_executable" ]]; then
  echo "No supported Chromium executable is available for blade proof." >&2
  exit 1
fi

export PLAYWRIGHT_CHROMIUM_EXECUTABLE="$browser_executable"
export SOURCE_SHA="${BLADE_PROOF_SOURCE_SHA:-$(git rev-parse HEAD 2>/dev/null || printf dirty)}"
export BLADE_PROOF_OUTPUT="$output_dir"
export BLADE_PROOF_PORT="$port"

node docs/proof/bay-public-reference-blade/run-proof.mjs

test -s "$output_dir/trace.zip"
test -s "$output_dir/overview-blade.png"
test -s "$output_dir/bay-blade.png"
test -s "$output_dir/proof-summary.json"
