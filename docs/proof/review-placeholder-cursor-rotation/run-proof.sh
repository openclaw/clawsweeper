#!/usr/bin/env bash
set -euo pipefail

export CI=1
export WRANGLER_SEND_METRICS=false

output_dir="${PROOF_OUTPUT:-.artifacts/review-placeholder-cursor-rotation}"
port="${PROOF_PORT:-8798}"
state_dir="$(mktemp -d /tmp/review-placeholder-cursor-proof.XXXXXX)"
wrangler_log="${output_dir}/wrangler.log"
mkdir -p "$output_dir"

pnpm install --frozen-lockfile >"${output_dir}/install.log" 2>&1
pnpm run build:all >"${output_dir}/build.log" 2>&1
node --test test/review-placeholder-recovery.test.ts test/dashboard-worker.test.ts \
  >"${output_dir}/focused-tests.tap" 2>&1

npx --yes wrangler@4.107.0 dev --config dashboard/wrangler.toml --local \
  --persist-to "$state_dir" --ip 127.0.0.1 --port "$port" \
  --var CLAWSWEEPER_WEBHOOK_SECRET:placeholder-cursor-proof-secret \
  --log-level warn >"$wrangler_log" 2>&1 &
wrangler_pid=$!
cleanup() {
  kill "$wrangler_pid" >/dev/null 2>&1 || true
  wait "$wrangler_pid" >/dev/null 2>&1 || true
  rm -rf -- "$state_dir"
}
trap cleanup EXIT

ready=false
for _ in $(seq 1 90); do
  if curl --fail --silent "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
    ready=true
    break
  fi
  if ! kill -0 "$wrangler_pid" >/dev/null 2>&1; then
    sed -n '1,220p' "$wrangler_log" >&2
    exit 1
  fi
  sleep 1
done
if [[ "$ready" != "true" ]]; then
  sed -n '1,220p' "$wrangler_log" >&2
  exit 1
fi

export PROOF_WORKER_ORIGIN="http://127.0.0.1:${port}"
export PROOF_OUTPUT="$output_dir"
export SOURCE_SHA="${PROOF_SOURCE_SHA:-$(git rev-parse HEAD 2>/dev/null || printf unknown)}"
export SOURCE_TREE_SHA="$(node -e '
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const files = [
  "dashboard/exact-review-queue.ts",
  "dashboard/worker.ts",
  "src/durable-cursor-store.ts",
  "src/review-placeholder-recovery.ts",
  "docs/proof/review-placeholder-cursor-rotation/README.md",
  "docs/proof/review-placeholder-cursor-rotation/run-proof.mjs",
  "docs/proof/review-placeholder-cursor-rotation/run-proof.sh",
];
const hash = createHash("sha256");
for (const file of files) hash.update(file).update("\0").update(readFileSync(file)).update("\0");
process.stdout.write(hash.digest("hex"));
')"
node docs/proof/review-placeholder-cursor-rotation/run-proof.mjs \
  | tee "${output_dir}/proof-output.txt"
test -s "${output_dir}/proof-summary.json"
test -s "${output_dir}/runtime-transcript.md"
