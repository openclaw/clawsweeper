#!/usr/bin/env bash
set -euo pipefail

export CI=1
export WRANGLER_SEND_METRICS=false
export PROOF_WEBHOOK_SECRET=phase0-6-disposable-local-secret
export PROOF_BASE_URL=http://127.0.0.1:8787

output_dir="${CSW_127_PHASE0_6_PROOF_OUTPUT:-.artifacts/csw-127-phase0-6-proof}"
state_dir="$(mktemp -d /tmp/csw-127-phase0-6-state.XXXXXX)"
wrangler_log="${output_dir}/wrangler.log"
worker_pid=""
queue_db=""
mkdir -p "$output_dir"
: >"$wrangler_log"

stop_worker() {
  if test -z "$worker_pid"; then return; fi
  local -a worker_pids=("$worker_pid")
  local child_pid
  while IFS= read -r child_pid; do worker_pids+=("$child_pid"); done < <(
    ps -eo pid=,ppid= | awk -v root="$worker_pid" '
      { parent[$1] = $2 }
      END {
        for (pid in parent) {
          current = pid
          for (depth = 0; depth < 100 && current in parent; depth++) {
            current = parent[current]
            if (current == root) { print pid; break }
          }
        }
      }'
  )
  kill "${worker_pids[@]}" >/dev/null 2>&1 || true
  wait "$worker_pid" >/dev/null 2>&1 || true
  worker_pid=""
  for _ in $(seq 1 50); do
    if ! curl --silent --max-time 1 "${PROOF_BASE_URL}/api/health" >/dev/null 2>&1; then return; fi
    sleep 0.1
  done
  echo "Wrangler process tree survived the requested stop" >&2
  exit 1
}

cleanup() {
  status=$?
  trap - EXIT
  stop_worker || true
  sed -i "s/${PROOF_WEBHOOK_SECRET}/[redacted-local-proof-secret]/g" "$wrangler_log"
  rm -rf -- "$state_dir"
  exit "$status"
}
trap cleanup EXIT

start_worker() {
  npm_config_ignore_scripts=true npx --yes wrangler@4.107.0 dev \
    --config dashboard/wrangler.toml \
    --local \
    --persist-to "$state_dir" \
    --ip 127.0.0.1 \
    --port 8787 \
    --var "CLAWSWEEPER_WEBHOOK_SECRET:${PROOF_WEBHOOK_SECRET}" \
    --var "EXACT_REVIEW_PUBLICATION_BATCH_WAIT_MS:0" \
    >>"$wrangler_log" 2>&1 &
  worker_pid=$!
  for _ in $(seq 1 90); do
    if curl --fail --silent "${PROOF_BASE_URL}/api/health" >/dev/null 2>&1; then return; fi
    if ! kill -0 "$worker_pid" >/dev/null 2>&1; then
      tail -n 160 "$wrangler_log" >&2
      exit 1
    fi
    sleep 1
  done
  tail -n 160 "$wrangler_log" >&2
  exit 1
}

mkdir -p "${HOME}/.local/bin"
corepack enable --install-directory "${HOME}/.local/bin"
export PATH="${HOME}/.local/bin:${PATH}"

echo CRABBOX_PHASE:dependencies
pnpm install --frozen-lockfile
echo CRABBOX_PHASE:build
pnpm run build:all
echo CRABBOX_PHASE:focused_tests
node --test \
  test/github-egress-telemetry.test.ts \
  test/dashboard-worker-queue-runtime.test.ts \
  test/exact-review-publication-batches.test.ts \
  test/repair/exact-review-batch-cli.test.ts

echo CRABBOX_PHASE:worker_queue_transition
start_worker
node docs/proof/csw-127-phase0-6/run-proof.mjs queue "$output_dir"
stop_worker

while IFS= read -r candidate; do
  if test "$(node docs/proof/csw-127-phase0-6/seed-cap.mjs probe "$candidate")" = "1"; then
    queue_db="$candidate"
    break
  fi
done < <(find "$state_dir" -type f -name '*.sqlite' -print)
if test -z "$queue_db"; then
  echo "ExactReviewQueue SQLite Durable Object was not initialized" >&2
  exit 1
fi

echo CRABBOX_PHASE:seed_production_caps
node docs/proof/csw-127-phase0-6/seed-cap.mjs seed "$queue_db" "$output_dir"

echo CRABBOX_PHASE:worker_cap_eviction
start_worker
node docs/proof/csw-127-phase0-6/run-proof.mjs cap "$output_dir"
stop_worker

echo CRABBOX_PHASE:worker_restart
start_worker
node docs/proof/csw-127-phase0-6/run-proof.mjs verify "$output_dir"

echo CRABBOX_PHASE:broad_linux_gates
pnpm run check
git diff --check

node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = process.argv[1];
  const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
  const receipt = {
    ok: true,
    provider: "local-container",
    worker: "wrangler@4.107.0 --local",
    durable_object: "SQLite ExactReviewQueue",
    queue: read("queue-stage.json"),
    cap: read("cap-stage.json"),
    restart: read("restart-stage.json"),
    seed: read("seed-receipt.json"),
  };
  fs.writeFileSync(path.join(dir, "runtime-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  process.stdout.write(JSON.stringify(receipt));
' "$output_dir"
