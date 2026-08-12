#!/usr/bin/env bash
set -euo pipefail

export CI=1
export PROOF_WEBHOOK_SECRET=phase0-5-proof-secret
export PROOF_BASE_URL=http://127.0.0.1:8787

mkdir -p "${HOME}/.local/bin"
corepack enable --install-directory "${HOME}/.local/bin"
export PATH="${HOME}/.local/bin:${PATH}"

pnpm install --frozen-lockfile

echo CRABBOX_PHASE:build
pnpm run build:all

echo CRABBOX_PHASE:focused_tests
node --test \
  test/github-egress-telemetry.test.ts \
  test/exact-review-publication-batches.test.ts \
  test/dashboard-worker-command-intake.test.ts \
  test/dashboard-worker-queue-policy.test.ts \
  test/dashboard-worker-queue-runtime.test.ts \
  test/exact-review-health.test.ts \
  test/dashboard-worker-bay-records-routes.test.ts

echo CRABBOX_PHASE:worker_do_proof
proof_log="$(mktemp)"
npx --yes wrangler@4.107.0 dev \
  --local \
  --config dashboard/wrangler.toml \
  --ip 127.0.0.1 \
  --port 8787 \
  --var "CLAWSWEEPER_WEBHOOK_SECRET:${PROOF_WEBHOOK_SECRET}" \
  >"${proof_log}" 2>&1 &
worker_pid=$!
cleanup() {
  kill "${worker_pid}" >/dev/null 2>&1 || true
  wait "${worker_pid}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for _ in $(seq 1 60); do
  if curl --fail --silent "${PROOF_BASE_URL}/api/health" >/dev/null; then
    break
  fi
  if ! kill -0 "${worker_pid}" >/dev/null 2>&1; then
    cat "${proof_log}"
    exit 1
  fi
  sleep 1
done
curl --fail --silent "${PROOF_BASE_URL}/api/health" >/dev/null || {
  cat "${proof_log}"
  exit 1
}
node docs/proof/csw-127-phase0-5/run-proof.mjs

echo CRABBOX_PHASE:scoped_lint
pnpm run lint:dashboard
pnpm run lint:scripts
