#!/usr/bin/env bash
set -euo pipefail

export CI=1
export PROOF_WEBHOOK_SECRET=phase0-5-proof-secret
export PROOF_BASE_URL=http://127.0.0.1:8787
export PROOF_GITHUB_MOCK_URL=http://127.0.0.1:8790
export PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

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
mock_log="$(mktemp)"
proof_key="$(mktemp)"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "${proof_key}" 2>/dev/null
proof_key_value="$(awk '{printf "%s\\n",$0}' "${proof_key}")"
node docs/proof/csw-127-phase0-5/github-mock.mjs >"${mock_log}" 2>&1 &
mock_pid=$!
npx --yes wrangler@4.107.0 dev \
  --local \
  --config dashboard/wrangler.toml \
  --ip 127.0.0.1 \
  --port 8787 \
  --var "CLAWSWEEPER_WEBHOOK_SECRET:${PROOF_WEBHOOK_SECRET}" \
  --var "GITHUB_API_URL:${PROOF_GITHUB_MOCK_URL}" \
  --var "CLAWSWEEPER_APP_ID:12345" \
  --var "CLAWSWEEPER_APP_PRIVATE_KEY:${proof_key_value}" \
  --var "EXACT_REVIEW_DISPATCH_DEBOUNCE_MS:0" \
  --var "EXACT_REVIEW_DISPATCH_DEBOUNCE_MAX_MS:0" \
  >"${proof_log}" 2>&1 &
worker_pid=$!
cleanup() {
  kill "${worker_pid}" >/dev/null 2>&1 || true
  wait "${worker_pid}" >/dev/null 2>&1 || true
  kill "${mock_pid}" >/dev/null 2>&1 || true
  wait "${mock_pid}" >/dev/null 2>&1 || true
  rm -f "${proof_key}" "${mock_log}" "${proof_log}"
}
trap cleanup EXIT

for _ in $(seq 1 30); do
  if curl --fail --silent "${PROOF_GITHUB_MOCK_URL}/health" >/dev/null; then
    break
  fi
  sleep 1
done
curl --fail --silent "${PROOF_GITHUB_MOCK_URL}/health" >/dev/null || {
  cat "${mock_log}"
  exit 1
}

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

echo CRABBOX_PHASE:bay_render_proof
npx --yes playwright@1.60.0 screenshot \
  --browser=chromium \
  --proxy-server="http://127.0.0.1:9" \
  --proxy-bypass="127.0.0.1,localhost" \
  --viewport-size="1440,500" \
  --wait-for-timeout=3000 \
  "${PROOF_BASE_URL}/bay" \
  docs/proof/csw-127-phase0-5/bay-recovery.png
test -s docs/proof/csw-127-phase0-5/bay-recovery.png

echo CRABBOX_PHASE:scoped_lint
pnpm run lint:dashboard
pnpm run lint:scripts
