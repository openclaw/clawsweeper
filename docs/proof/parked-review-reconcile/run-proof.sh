#!/usr/bin/env bash
set -euo pipefail

export CI=1
export WRANGLER_SEND_METRICS=false
export PATH="$HOME/.local/bin:$PATH"

output_dir="${PARKED_REVIEW_RECONCILE_PROOF_OUTPUT:-docs/proof/parked-review-reconcile/artifacts}"
worker_port="${PARKED_REVIEW_RECONCILE_WORKER_PORT:-8798}"
github_port="${PARKED_REVIEW_RECONCILE_GITHUB_PORT:-8898}"
webhook_secret="parked-review-reconcile-local-webhook-secret"
operator_secret="parked-review-reconcile-local-operator-secret"
state_dir="$(mktemp -d /tmp/parked-review-reconcile-state.XXXXXX)"
key_dir="$(mktemp -d /tmp/parked-review-reconcile-key.XXXXXX)"
wrangler_raw_log="$(mktemp /tmp/parked-review-reconcile-wrangler.XXXXXX)"
stub_log="$(mktemp /tmp/parked-review-reconcile-stub.XXXXXX)"
worker_pid=""
stub_pid=""
queue_db=""

mkdir -p "$output_dir" "$HOME/.local/bin"
corepack enable --install-directory "$HOME/.local/bin"

stop_tree() {
  local root_pid="$1"
  if test -z "$root_pid" || ! kill -0 "$root_pid" >/dev/null 2>&1; then
    return
  fi
  local -a process_ids=("$root_pid")
  local child_pid
  while IFS= read -r child_pid; do
    process_ids+=("$child_pid")
  done < <(
    ps -eo pid=,ppid= | awk -v root="$root_pid" '
      { parent[$1] = $2 }
      END {
        for (pid in parent) {
          current = pid
          for (depth = 0; depth < 100 && current in parent; depth++) {
            current = parent[current]
            if (current == root) { print pid; break }
          }
        }
      }
    '
  )
  kill "${process_ids[@]}" >/dev/null 2>&1 || true
  wait "$root_pid" >/dev/null 2>&1 || true
}

stop_worker() {
  if test -n "$worker_pid"; then
    stop_tree "$worker_pid"
    worker_pid=""
    local stopped=false
    for _ in $(seq 1 50); do
      if ! curl --silent --max-time 1 "http://127.0.0.1:${worker_port}/api/health" >/dev/null 2>&1; then
        stopped=true
        break
      fi
      sleep 0.1
    done
    test "$stopped" = true
  fi
}

cleanup() {
  stop_worker
  if test -n "$stub_pid"; then
    stop_tree "$stub_pid"
  fi
  sed -e "s/${webhook_secret}/[redacted-local-webhook-secret]/g" \
    -e "s/${operator_secret}/[redacted-local-operator-secret]/g" \
    "$wrangler_raw_log" >"${output_dir}/wrangler.log"
  cp "$stub_log" "${output_dir}/stub.log"
  rm -f -- "$wrangler_raw_log" "$stub_log"
  rm -rf -- "$state_dir" "$key_dir"
}
trap cleanup EXIT

start_worker() {
  local fast_debounce="$1"
  local -a debounce_args=()
  if test "$fast_debounce" = true; then
    debounce_args=(
      --var "EXACT_REVIEW_DISPATCH_DEBOUNCE_MS:0"
      --var "EXACT_REVIEW_DISPATCH_DEBOUNCE_MAX_MS:0"
    )
  fi
  local app_private_key
  app_private_key="$(<"${key_dir}/app-private.pem")"
  npm_config_ignore_scripts=true npx --yes wrangler@4.107.0 dev \
    --config dashboard/wrangler.toml \
    --local \
    --persist-to "$state_dir" \
    --ip 127.0.0.1 \
    --port "$worker_port" \
    --var "CLAWSWEEPER_WEBHOOK_SECRET:${webhook_secret}" \
    --var "EXACT_REVIEW_OPERATOR_SECRET:${operator_secret}" \
    --var "GITHUB_API_URL:http://127.0.0.1:${github_port}" \
    --var "CLAWSWEEPER_APP_CLIENT_ID:parked-proof-app" \
    --var "CLAWSWEEPER_APP_PRIVATE_KEY:${app_private_key}" \
    "${debounce_args[@]}" \
    >>"$wrangler_raw_log" 2>&1 &
  worker_pid=$!
  local ready=false
  for _ in $(seq 1 90); do
    if curl --fail --silent "http://127.0.0.1:${worker_port}/api/health" >/dev/null 2>&1; then
      ready=true
      break
    fi
    if ! kill -0 "$worker_pid" >/dev/null 2>&1; then
      sed -n '1,240p' "$wrangler_raw_log" >&2
      exit 1
    fi
    sleep 1
  done
  test "$ready" = true
}

pnpm install --frozen-lockfile >"${output_dir}/dependencies-install.log" 2>&1
pnpm run build:dashboard >"${output_dir}/build-dashboard.log" 2>&1
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
  -out "${key_dir}/app-private.pem" >/dev/null 2>&1

node docs/proof/parked-review-reconcile/stub-github.mjs \
  "$github_port" "${output_dir}/github-trace.jsonl" >"$stub_log" 2>&1 &
stub_pid=$!
stub_ready=false
for _ in $(seq 1 50); do
  if curl --fail --silent "http://127.0.0.1:${github_port}/__proof/status" >/dev/null 2>&1; then
    stub_ready=true
    break
  fi
  sleep 0.2
done
test "$stub_ready" = true

export PARKED_REVIEW_RECONCILE_PROOF_OUTPUT="$output_dir"
export PARKED_REVIEW_RECONCILE_WORKER_ORIGIN="http://127.0.0.1:${worker_port}"
export PARKED_REVIEW_RECONCILE_GITHUB_ORIGIN="http://127.0.0.1:${github_port}"
export PARKED_REVIEW_RECONCILE_WEBHOOK_SECRET="$webhook_secret"
export PARKED_REVIEW_RECONCILE_OPERATOR_SECRET="$operator_secret"
export SOURCE_SHA="$(git rev-parse HEAD)"

start_worker true
node docs/proof/parked-review-reconcile/run-proof.mjs exhaust \
  | tee "${output_dir}/exhaustion-transcript.log"
stop_worker

while IFS= read -r candidate; do
  if test "$(node docs/proof/parked-review-reconcile/assert-durable-object.mjs "$candidate")" = "1"; then
    queue_db="$candidate"
    break
  fi
done < <(find "$state_dir" -type f -name '*.sqlite' -print)
if test -z "$queue_db"; then
  echo "Durable Object did not initialize the parked action table" >&2
  exit 1
fi
printf '%s\n' "Durable Object instantiated: exact_review_queue_parked_actions table present" \
  >"${output_dir}/durable-object-assertion.txt"

start_worker false
node docs/proof/parked-review-reconcile/run-proof.mjs reconcile \
  | tee "${output_dir}/reconcile-transcript.log"

test -s "${output_dir}/proof-summary.json"
test -s "${output_dir}/parked-inventory-exhausted.json"
test -s "${output_dir}/parked-operator-inventory.json"
test -s "${output_dir}/command-context-target-after.json"
test -s "${output_dir}/command-context-resolve-refusal.json"
test -s "${output_dir}/command-context-recover-refusal.json"
test -s "${output_dir}/durable-object-assertion.txt"
echo "PROOF_RC=0"
