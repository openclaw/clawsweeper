#!/usr/bin/env bash
set -euo pipefail

export CI=1
export WRANGLER_SEND_METRICS=false

output_dir="${CSW_098_PROOF_OUTPUT:-docs/proof/csw-098/artifacts}"
port="${CSW_098_PROOF_PORT:-8798}"
deps_dir="/tmp/csw-098-playwright"
wrangler_log="${output_dir}/wrangler.log"
worker_activity_file="${output_dir}/actual-worker-live-activity.json"
state_dir="$(mktemp -d /tmp/csw-098-wrangler-state.XXXXXX)"

mkdir -p "$output_dir" "$deps_dir"
npm install --prefix "$deps_dir" --no-audit --no-fund \
  playwright@1.60.0 typescript@7.0.2 @types/node@26.1.1 yaml@2.9.0 \
  >"${output_dir}/proof-dependencies-install.log" 2>&1
if [[ ! -e node_modules ]]; then
  ln -sfn "$deps_dir/node_modules" node_modules
fi

"${deps_dir}/node_modules/.bin/tsc" -p tsconfig.dashboard.json \
  >"${output_dir}/build-dashboard.log" 2>&1
corepack pnpm run build:repair >"${output_dir}/build-repair.log" 2>&1
node --test --test-name-pattern="live activity|OpenClaw Bay is an unlisted" test/dashboard-worker.test.ts \
  >"${output_dir}/focused-dashboard.tap" 2>&1

npx --yes wrangler@4.107.0 dev \
  --config dashboard/wrangler.toml \
  --local \
  --persist-to "$state_dir" \
  --ip 127.0.0.1 \
  --port "$port" \
  >"$wrangler_log" 2>&1 &
wrangler_pid=$!

cleanup() {
  kill "$wrangler_pid" >/dev/null 2>&1 || true
  wait "$wrangler_pid" >/dev/null 2>&1 || true
  rm -rf -- "$state_dir"
}
trap cleanup EXIT

for _ in $(seq 1 90); do
  if curl --fail --silent "http://127.0.0.1:${port}/bay-demo" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$wrangler_pid" >/dev/null 2>&1; then
    sed -n '1,220p' "$wrangler_log" >&2
    exit 1
  fi
  sleep 1
done

# This is the actual Wrangler-built Worker endpoint. A local Worker has no
# GitHub credentials, so its bounded status source must fail closed as Unknown;
# it must not manufacture lifecycle cards, lanes, or activity details.
activity_status="$(curl --silent --show-error --output "$worker_activity_file" --write-out '%{http_code}' \
  "http://127.0.0.1:${port}/api/live-activity-bay")"
test "$activity_status" = "200"
node -e 'const fs=require("node:fs"); const body=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const live=body.live_activity_bay; if (!live || live.collection?.state!=="unknown" || live.activity!==null || "lanes" in live || "cards" in live) process.exit(1);' \
  "$worker_activity_file"

export CSW_098_PROOF_OUTPUT="$output_dir"
export CSW_098_PROOF_PORT="$port"
export CSW_098_WORKER_ACTIVITY_STATUS="$activity_status"
export PLAYWRIGHT_MODULE="file://${deps_dir}/node_modules/playwright/index.mjs"
export PLAYWRIGHT_CHROMIUM_EXECUTABLE="/ms-playwright/chromium-1223/chrome-linux64/chrome"
export SOURCE_SHA="${CSW_098_PROOF_SOURCE_SHA:-$(git rev-parse HEAD 2>/dev/null || printf unknown)}"
export SOURCE_TREE_SHA="${CSW_098_PROOF_SOURCE_TREE_SHA:-$(sha256sum dashboard/live-activity.ts dashboard/worker.ts dashboard/bay-page.ts test/dashboard-worker.test.ts docs/proof/csw-098/run-proof.sh docs/proof/csw-098/run-proof.mjs | sha256sum | awk '{ print $1 }')}"

node docs/proof/csw-098/run-proof.mjs

test -s "${output_dir}/live-activity-active.jpg"
test -s "${output_dir}/live-activity-unknown.jpg"
test -s "${output_dir}/proof-summary.json"
test -s "${output_dir}/runtime-transcript.md"
test -s "${output_dir}/trace.zip"
