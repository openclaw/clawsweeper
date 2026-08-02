#!/usr/bin/env bash
set -euo pipefail

export CI=1
export WRANGLER_SEND_METRICS=false

output_dir="${CSW_099_PROOF_OUTPUT:-docs/proof/csw-099/artifacts}"
port="${CSW_099_PROOF_PORT:-8799}"
deps_dir="/tmp/csw-099-playwright"
state_dir="$(mktemp -d /tmp/csw-099-wrangler-state.XXXXXX)"
wrangler_log="${output_dir}/wrangler.log"
mkdir -p "$output_dir" "$deps_dir"

npm install --prefix "$deps_dir" --no-audit --no-fund \
  playwright@1.60.0 typescript@7.0.2 @types/node@26.1.1 yaml@2.9.0 \
  >"${output_dir}/proof-dependencies-install.log" 2>&1
if [[ ! -e node_modules ]]; then
  ln -sfn "$deps_dir/node_modules" node_modules
fi
"${deps_dir}/node_modules/.bin/tsc" -p tsconfig.repair.json >"${output_dir}/build-repair.log" 2>&1
"${deps_dir}/node_modules/.bin/tsc" -p tsconfig.dashboard.json >"${output_dir}/build-dashboard.log" 2>&1
node --test --test-name-pattern="operator lifecycle audit inventory" test/dashboard-worker.test.ts \
  >"${output_dir}/focused-worker-do.tap" 2>&1

npx --yes wrangler@4.107.0 dev --config dashboard/wrangler.toml --local \
  --persist-to "$state_dir" --ip 127.0.0.1 --port "$port" \
  --var EXACT_REVIEW_OPERATOR_SECRET:operator-proof-secret \
  >"$wrangler_log" 2>&1 &
wrangler_pid=$!
cleanup() {
  kill "$wrangler_pid" >/dev/null 2>&1 || true
  wait "$wrangler_pid" >/dev/null 2>&1 || true
  rm -rf -- "$state_dir"
}
trap cleanup EXIT
for _ in $(seq 1 90); do
  if curl --fail --silent "http://127.0.0.1:${port}/bay-demo" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$wrangler_pid" >/dev/null 2>&1; then sed -n '1,220p' "$wrangler_log" >&2; exit 1; fi
  sleep 1
done

# Initialize only the disposable local DO through an existing read path.
curl --fail --silent "http://127.0.0.1:${port}/api/recent-durable-publication-events?window=24h" \
  >"${output_dir}/ordinary-queue-read.json"
body='{"page_size":2}'
signature="$(node -e 'const {createHmac}=require("node:crypto"); process.stdout.write("sha256="+createHmac("sha256", process.argv[1]).update(process.argv[2]).digest("hex"))' operator-proof-secret "$body")"
curl --fail --silent --show-error --request POST \
  --header "x-clawsweeper-exact-review-signature: ${signature}" \
  --header "content-type: application/json" --data "$body" \
  "http://127.0.0.1:${port}/internal/exact-review/lifecycle-audit/inventory" \
  >"${output_dir}/worker-inventory.json"
shared_signature="$(node -e 'const {createHmac}=require("node:crypto"); process.stdout.write("sha256="+createHmac("sha256", process.argv[1]).update(process.argv[2]).digest("hex"))' shared-secret "$body")"
curl --silent --output /dev/null --write-out '%{http_code}' --request POST \
  --header "x-clawsweeper-exact-review-signature: ${shared_signature}" \
  --header "content-type: application/json" --data "$body" \
  "http://127.0.0.1:${port}/internal/exact-review/lifecycle-audit/inventory" \
  >"${output_dir}/shared-secret-status.txt"
curl --silent --output /dev/null --write-out '%{http_code}' \
  "http://127.0.0.1:${port}/api/lifecycle-audit/inventory" \
  >"${output_dir}/public-probe-status.txt"

export CSW_099_PROOF_OUTPUT="$output_dir"
export CSW_099_PROOF_PORT="$port"
export PLAYWRIGHT_MODULE="file://${deps_dir}/node_modules/playwright/index.mjs"
export PLAYWRIGHT_CHROMIUM_EXECUTABLE="/ms-playwright/chromium-1223/chrome-linux64/chrome"
export SOURCE_SHA="${CSW_099_PROOF_SOURCE_SHA:-$(git rev-parse HEAD 2>/dev/null || printf unknown)}"
export SOURCE_TREE_SHA="$(sha256sum dashboard/exact-review-lifecycle.ts dashboard/exact-review-queue.ts dashboard/worker.ts test/dashboard-worker.test.ts docs/proof/csw-099/README.md docs/proof/csw-099/run-proof.mjs docs/proof/csw-099/run-proof.sh | sha256sum | awk '{ print $1 }')"
node docs/proof/csw-099/run-proof.mjs
test -s "${output_dir}/proof-summary.json"
test -s "${output_dir}/runtime-transcript.md"
test -s "${output_dir}/public-bay-separation.jpg"
test -s "${output_dir}/trace.zip"
