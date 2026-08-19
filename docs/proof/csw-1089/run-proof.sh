#!/usr/bin/env bash
set -euo pipefail

export CI=1
export WRANGLER_SEND_METRICS=false

output_dir="${CSW_1089_PROOF_OUTPUT:-docs/proof/csw-1089/artifacts}"
worker_port="${CSW_1089_WORKER_PORT:-8799}"
transport_port="${CSW_1089_TRANSPORT_PORT:-8899}"
proof_secret="csw-1089-disposable-local-proof-secret"
wrangler_raw_log="$(mktemp /tmp/csw-1089-wrangler-log.XXXXXX)"
state_dir="$(mktemp -d /tmp/csw-1089-wrangler-state.XXXXXX)"
tls_dir="$(mktemp -d /tmp/csw-1089-tls.XXXXXX)"
wrangler_pid=""

mkdir -p "$output_dir"

cleanup() {
  if test -n "$wrangler_pid"; then
    kill "$wrangler_pid" >/dev/null 2>&1 || true
    wait "$wrangler_pid" >/dev/null 2>&1 || true
  fi
  if test -f "$wrangler_raw_log"; then
    sed "s/${proof_secret}/[redacted-local-proof-secret]/g" "$wrangler_raw_log" \
      | sed -n '1,240p' >"${output_dir}/wrangler.log"
  fi
  rm -f -- "$wrangler_raw_log"
  rm -rf -- "$state_dir" "$tls_dir"
}
trap cleanup EXIT

pnpm install --frozen-lockfile >"${output_dir}/dependencies-install.log" 2>&1
pnpm run build:repair >"${output_dir}/build-repair.log" 2>&1
pnpm run build:dashboard >"${output_dir}/build-dashboard.log" 2>&1

openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj '/CN=127.0.0.1' \
  -addext 'subjectAltName=IP:127.0.0.1' \
  -keyout "${tls_dir}/key.pem" \
  -out "${tls_dir}/cert.pem" \
  >/dev/null 2>&1

npm_config_ignore_scripts=true npx --yes wrangler@4.107.0 dev \
  --config dashboard/wrangler.toml \
  --local \
  --persist-to "$state_dir" \
  --ip 127.0.0.1 \
  --port "$worker_port" \
  --var "CLAWSWEEPER_WEBHOOK_SECRET:${proof_secret}" \
  >"$wrangler_raw_log" 2>&1 &
wrangler_pid=$!

ready=false
for _ in $(seq 1 90); do
  if curl --fail --silent "http://127.0.0.1:${worker_port}/api/health" >/dev/null 2>&1; then
    ready=true
    break
  fi
  if ! kill -0 "$wrangler_pid" >/dev/null 2>&1; then
    sed -n '1,220p' "$wrangler_raw_log" >&2
    exit 1
  fi
  sleep 1
done
test "$ready" = true

export CSW_1089_PROOF_OUTPUT="$output_dir"
export CSW_1089_WORKER_ORIGIN="http://127.0.0.1:${worker_port}"
export CSW_1089_TRANSPORT_PORT="$transport_port"
export CSW_1089_TLS_KEY="${tls_dir}/key.pem"
export CSW_1089_TLS_CERT="${tls_dir}/cert.pem"
export CSW_1089_PROOF_SECRET="$proof_secret"
export SOURCE_SHA="${CSW_1089_PROOF_SOURCE_SHA:-$(git rev-parse HEAD)}"
export SOURCE_TREE_SHA="$(node -e '
  const { createHash } = require("node:crypto");
  const { readFileSync } = require("node:fs");
  const hash = createHash("sha256");
  for (const file of process.argv.slice(1)) hash.update(file).update("\0").update(readFileSync(file));
  process.stdout.write(hash.digest("hex"));
' \
  src/repair/exact-review-batch-cli.ts \
  dashboard/exact-review-publication-retry.ts \
  dashboard/exact-review-queue.ts \
  dashboard/worker.ts \
  docs/proof/csw-1089/README.md \
  docs/proof/csw-1089/run-proof.sh \
  docs/proof/csw-1089/run-proof.mjs)"

node docs/proof/csw-1089/run-proof.mjs

test -s "${output_dir}/runtime-transcript.md"
test -s "${output_dir}/proof-summary.json"
test -s "${output_dir}/transport-requests.json"
test -s "${output_dir}/completion-no-status.json"
test -s "${output_dir}/completion-429.json"
test -s "${output_dir}/completion-503.json"
test -s "${output_dir}/queue-state-state-contention-after.json"
test -s "${output_dir}/queue-state-unknown-after-attempt-1.json"
