#!/usr/bin/env bash
set -euo pipefail

export CI=1
export WRANGLER_SEND_METRICS=false

output_dir="${BAY_TELEMETRY_PROOF_OUTPUT:-.artifacts/bay-telemetry-health}"
port="${BAY_TELEMETRY_PROOF_PORT:-8787}"
deps_dir="/tmp/bay-telemetry-health-playwright"
wrangler_log="/tmp/bay-telemetry-health-wrangler.log"

rm -rf "$output_dir" "$deps_dir"
mkdir -p "$output_dir" "$deps_dir"

export PNPM_HOME="$HOME/.local/bin"
mkdir -p "$PNPM_HOME"
export PATH="$PNPM_HOME:$PATH"
if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable --install-directory "$PNPM_HOME" >"$output_dir/corepack.log" 2>&1 || true
fi
if ! command -v pnpm >/dev/null 2>&1; then
  npm install -g --prefix "$HOME/.local" pnpm@11.10.0 \
    >"$output_dir/pnpm-bootstrap.log" 2>&1
fi
pnpm --version >"$output_dir/pnpm-version.log"
pnpm install --frozen-lockfile >"$output_dir/pnpm-install.log" 2>&1
pnpm run build:all >"$output_dir/build.log" 2>&1

node --test \
  --test-name-pattern='durable lifecycle Bay is a pure|durable lifecycle Bay fail-closes' \
  test/dashboard-worker-observability.test.ts \
  >"$output_dir/focused-tests.tap" 2>&1

npm install --prefix "$deps_dir" --no-audit --no-fund playwright@1.60.0 \
  >"$output_dir/playwright-install.log" 2>&1

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
    cp "$wrangler_log" "$output_dir/wrangler.log"
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
  echo "No supported Chromium executable is available for Bay browser proof." >&2
  exit 1
fi

export PLAYWRIGHT_CHROMIUM_EXECUTABLE="$browser_executable"
export BAY_TELEMETRY_PROOF_SOURCE_SHA="${BAY_TELEMETRY_PROOF_SOURCE_SHA:-$(git rev-parse HEAD)}"
export BAY_TELEMETRY_PROOF_OUTPUT="$output_dir"
export BAY_TELEMETRY_PROOF_PORT="$port"

node docs/proof/bay-telemetry-health/run-proof.mjs
cp "$wrangler_log" "$output_dir/wrangler.log"

test -s "$output_dir/focused-tests.tap"
test -s "$output_dir/bay.png"
test -s "$output_dir/bay-incomplete.png"
test -s "$output_dir/bay-recovered.png"
test -s "$output_dir/proof-summary.json"
