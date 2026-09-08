#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
export WRANGLER_SEND_METRICS=false
mkdir -p .artifacts/bay-inline-proof
state=$(mktemp -d)
cleanup() { kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; rm -rf "$state"; }
pnpm dlx wrangler@4.107.0 dev --config docs/proof/bay-inline-proof/wrangler.toml --local --ip 127.0.0.1 --port 8793 --persist-to "$state" > .artifacts/bay-inline-proof/wrangler.log 2>&1 &
pid=$!
trap cleanup EXIT
for _ in $(seq 1 90); do
  if curl -fsS http://127.0.0.1:8793/api/health >/dev/null 2>&1; then break; fi
  if ! kill -0 "$pid" 2>/dev/null; then cat .artifacts/bay-inline-proof/wrangler.log; exit 1; fi
  sleep 1
done
node docs/proof/bay-inline-proof/run-proof.mjs
