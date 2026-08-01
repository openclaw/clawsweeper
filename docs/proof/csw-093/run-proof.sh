#!/usr/bin/env bash
set -euo pipefail

export CI=1
export WRANGLER_SEND_METRICS=false

output_dir="${CSW_093_PROOF_OUTPUT:-docs/proof/csw-093/artifacts}"
port="${CSW_093_PROOF_PORT:-8793}"
deps_dir="/tmp/csw-093-playwright"
wrangler_log="${output_dir}/wrangler.log"
pure_read_file="${output_dir}/actual-worker-do-read.json"
ordinary_queue_file="${output_dir}/ordinary-queue-after-pure-read.json"
state_dir="$(mktemp -d /tmp/csw-093-wrangler-state.XXXXXX)"

mkdir -p "$output_dir" "$deps_dir"

npm install --prefix "$deps_dir" --no-audit --no-fund \
  playwright@1.60.0 typescript@7.0.2 @types/node@26.1.1 yaml@2.9.0 \
  >"${output_dir}/proof-dependencies-install.log" 2>&1
ln -sfn "$deps_dir/node_modules" node_modules

"${deps_dir}/node_modules/.bin/tsc" -p tsconfig.repair.json \
  >"${output_dir}/build-repair.log" 2>&1
"${deps_dir}/node_modules/.bin/tsc" -p tsconfig.dashboard.json \
  >"${output_dir}/build-dashboard.log" 2>&1
node --test --test-name-pattern="durable lifecycle Bay" test/dashboard-worker.test.ts \
  >"${output_dir}/focused-worker-do.tap" 2>&1

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

# This is the actual Wrangler-built Worker -> DO read. A new local DO has no
# lifecycle schema, so the pure reader must fail closed as Unknown without
# initializing or repairing that state.
pure_read_status="$(curl --silent --show-error --output "$pure_read_file" --write-out '%{http_code}' \
  "http://127.0.0.1:${port}/api/durable-lifecycle-bay")"
test "$pure_read_status" = "200"
node -e 'const fs=require("node:fs"); const body=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const bay=body.durable_lifecycle_bay; if (!bay || bay.collection?.state!=="unknown" || bay.inventory!==null || bay.lanes!==null || bay.sample!==null) process.exit(1);' \
  "$pure_read_file"

# The next request exercises a normal initialized queue route against the same
# real local Worker/DO after the pure /lifecycle-bay read. It deliberately uses
# the existing aggregate-only public endpoint, not a queue mutation.
ordinary_queue_status="$(curl --silent --show-error --output "$ordinary_queue_file" --write-out '%{http_code}' \
  "http://127.0.0.1:${port}/api/recent-durable-publication-events?window=24h")"
test "$ordinary_queue_status" = "200"
node -e 'const fs=require("node:fs"); const body=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const events=body.recent_durable_publication_events; if (!events || events.collection?.state!=="complete" || events.collection?.complete!==true) process.exit(1);' \
  "$ordinary_queue_file"

export CSW_093_PROOF_OUTPUT="$output_dir"
export CSW_093_PROOF_PORT="$port"
export PLAYWRIGHT_MODULE="file://${deps_dir}/node_modules/playwright/index.mjs"
export PLAYWRIGHT_CHROMIUM_EXECUTABLE="/ms-playwright/chromium-1223/chrome-linux64/chrome"
export SOURCE_SHA="${CSW_093_PROOF_SOURCE_SHA:-$(git rev-parse HEAD 2>/dev/null || printf unknown)}"
export CSW_093_PURE_READ_STATUS="$pure_read_status"
export CSW_093_ORDINARY_QUEUE_STATUS="$ordinary_queue_status"
export SOURCE_TREE_SHA="$(sha256sum \
  dashboard/exact-review-lifecycle.ts \
  dashboard/exact-review-queue.ts \
  dashboard/worker.ts \
  dashboard/bay-page.ts \
  test/dashboard-worker.test.ts \
  docs/proof/csw-093/README.md \
  docs/proof/csw-093/run-proof.sh \
  docs/proof/csw-093/run-proof.mjs | sha256sum | awk '{ print $1 }')"

node docs/proof/csw-093/run-proof.mjs

test -s "${output_dir}/complete-lifecycle-kanban.jpg"
test -s "${output_dir}/unknown-lifecycle-kanban.jpg"
test -s "${output_dir}/proof-summary.json"
test -s "${output_dir}/runtime-transcript.md"
test -s "${output_dir}/worker-do-initialization-sequence.json"
test -s "${output_dir}/worker-do-initialization-transcript.txt"
test -s "${output_dir}/trace.zip"
