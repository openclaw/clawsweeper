#!/bin/sh
set -eu

demo_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH='' cd -- "$demo_dir/../../.." && pwd)
port=${1:-${PORT:-8787}}
origin="http://127.0.0.1:$port"
runtime_dir=$(mktemp -d "${TMPDIR:-/tmp}/clawsweeper-bay-demo.XXXXXX")
vars_file="$runtime_dir/.dev.vars"
state_dir="$runtime_dir/wrangler-state"
launcher_pid=$$

demo_secret=$(node --input-type=module -e '
  import { randomBytes } from "node:crypto";
  process.stdout.write(randomBytes(32).toString("hex"));
')

umask 077
printf '%s\n' \
  "CLAWSWEEPER_WEBHOOK_SECRET=$demo_secret" \
  "INGEST_TOKEN=$demo_secret" \
  "GITHUB_API_URL=http://127.0.0.1:9" \
  "CACHE_TTL_SECONDS=0" \
  "STALE_CACHE_TTL_SECONDS=0" \
  "INCLUDE_CI_STATUS=0" \
  "EXACT_REVIEW_DISPATCH_DEBOUNCE_MS=900000" \
  "EXACT_REVIEW_DISPATCH_DEBOUNCE_MAX_MS=900000" \
  "PUBLIC_BAY_REPOS=openclaw/openclaw,openclaw/clawhub,openclaw/clawsweeper,openclaw/fs-safe" \
  >"$vars_file"
mkdir -p "$state_dir"

(
  trap 'rm -f -- "$vars_file"' EXIT
  attempt=0
  until curl --fail --silent --max-time 2 "$origin/api/health" >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 240 ]; then
      echo "Timed out waiting for the OpenClaw Bay demo at $origin." >&2
      kill "$launcher_pid" 2>/dev/null || true
      exit 1
    fi
    sleep 1
  done

  if ! BAY_DEMO_WEBHOOK_SECRET="$demo_secret" node "$demo_dir/seed.mjs" "$origin"; then
    echo "Failed to seed the OpenClaw Bay demo at $origin." >&2
    kill "$launcher_pid" 2>/dev/null || true
    exit 1
  fi
  echo "OpenClaw Bay demo ready: $origin/bay"
) &

cd "$repo_dir"
exec pnpm dashboard:dev --local --ip 127.0.0.1 --port "$port" \
  --env-file "$vars_file" --persist-to "$state_dir"
