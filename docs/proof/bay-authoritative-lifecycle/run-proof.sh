#!/usr/bin/env bash
set -euo pipefail

# Exercise the public status route against a real local Worker and Durable
# Object. The fixture uses only local, signed internal lifecycle traffic.
export CI=1
export WRANGLER_SEND_METRICS=false

# Crabbox uploads --script files below .crabbox/scripts but executes them with
# the synced repository as the working directory.
root_dir=$PWD
output_dir="${BAY_LIFECYCLE_PROOF_OUTPUT:-.artifacts/bay-lifecycle-metrics}"
port="${BAY_LIFECYCLE_PROOF_PORT:-8791}"
runtime_dir=$(mktemp -d "${TMPDIR:-/tmp}/clawsweeper-bay-lifecycle.XXXXXX")
vars_file="$runtime_dir/.dev.vars"
wrangler_log="$runtime_dir/wrangler.log"

if [ -e "$output_dir" ]; then
  echo "Refusing to overwrite existing proof output: $output_dir" >&2
  exit 1
fi
mkdir -p "$output_dir"

secret=$(node --input-type=module -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(32).toString("hex"));')
umask 077
printf '%s\n' \
  "CLAWSWEEPER_WEBHOOK_SECRET=$secret" \
  "INGEST_TOKEN=$secret" \
  "GITHUB_API_URL=http://127.0.0.1:9" \
  "CACHE_TTL_SECONDS=0" \
  "STALE_CACHE_TTL_SECONDS=0" \
  "INCLUDE_CI_STATUS=0" \
  "EXACT_REVIEW_DISPATCH_DEBOUNCE_MS=900000" \
  "EXACT_REVIEW_DISPATCH_DEBOUNCE_MAX_MS=900000" \
  "PUBLIC_BAY_REPOS=openclaw/openclaw" \
  >"$vars_file"

cleanup() {
  if [ -n "${wrangler_pid:-}" ]; then
    kill "$wrangler_pid" >/dev/null 2>&1 || true
    wait "$wrangler_pid" >/dev/null 2>&1 || true
  fi
  rm -rf "$runtime_dir"
}
trap cleanup EXIT

cd "$root_dir"
# Keep Corepack in command mode: the pinned image has Node/Corepack but no
# writable global pnpm shim for its unprivileged local-container user.
corepack pnpm install --frozen-lockfile
corepack pnpm dashboard:dev --local --ip 127.0.0.1 --port "$port" --env-file "$vars_file" --persist-to "$runtime_dir/state" >"$wrangler_log" 2>&1 &
wrangler_pid=$!

for _ in $(seq 1 90); do
  if curl --fail --silent "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$wrangler_pid" >/dev/null 2>&1; then
    tail -n 100 "$wrangler_log" >&2
    exit 1
  fi
  sleep 1
done

curl --fail --silent --show-error "http://127.0.0.1:${port}/api/health" >/dev/null
BAY_LIFECYCLE_PROOF_ORIGIN="http://127.0.0.1:${port}" \
  BAY_LIFECYCLE_PROOF_SECRET="$secret" \
  BAY_LIFECYCLE_PROOF_OUTPUT="$output_dir" \
  node docs/proof/bay-authoritative-lifecycle/run-proof.mjs

test -s "$output_dir/proof-summary.json"
