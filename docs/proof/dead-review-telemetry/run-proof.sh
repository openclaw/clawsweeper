#!/usr/bin/env bash
set -euo pipefail

export CI=1
export WRANGLER_SEND_METRICS=false

output_dir="${DEAD_REVIEW_TELEMETRY_PROOF_OUTPUT:-docs/proof/dead-review-telemetry/artifacts}"
worker_port="${DEAD_REVIEW_TELEMETRY_PROOF_PORT:-8796}"
proof_secret="dead-review-telemetry-disposable-local-secret"
sqlite_helper="docs/proof/dead-review-telemetry/sqlite-proof.mjs"
proof_run_id="$(node -e '
  const { randomInt } = require("node:crypto");
  process.stdout.write(`${Date.now()}${randomInt(1_000_000).toString().padStart(6, "0")}`);
')"
state_dir="$(mktemp -d /tmp/dead-review-telemetry-state.XXXXXX)"
wrangler_raw_log="$(mktemp /tmp/dead-review-telemetry-wrangler.XXXXXX)"
wrangler_pid=""
queue_db=""

mkdir -p "$output_dir"

stop_worker() {
  if test -n "$wrangler_pid"; then
    local -a worker_pids=("$wrangler_pid")
    local child_pid
    while IFS= read -r child_pid; do
      worker_pids+=("$child_pid")
    done < <(
      ps -eo pid=,ppid= | awk -v root="$wrangler_pid" '
        { parent[$1] = $2 }
        END {
          for (pid in parent) {
            current = pid
            for (depth = 0; depth < 100 && current in parent; depth++) {
              current = parent[current]
              if (current == root) {
                print pid
                break
              }
            }
          }
        }
      '
    )
    kill "${worker_pids[@]}" >/dev/null 2>&1 || true
    wait "$wrangler_pid" >/dev/null 2>&1 || true
    wrangler_pid=""

    local stopped=false
    for _ in $(seq 1 50); do
      if ! curl --silent --max-time 1 "http://127.0.0.1:${worker_port}/api/health" \
        >/dev/null 2>&1; then
        stopped=true
        break
      fi
      sleep 0.1
    done
    if test "$stopped" != true; then
      echo "failed to stop the Wrangler process tree before restart" >&2
      exit 1
    fi
  fi
}

cleanup() {
  stop_worker
  sed "s/${proof_secret}/[redacted-local-proof-secret]/g" "$wrangler_raw_log" \
    >"${output_dir}/wrangler.log"
  rm -f -- "$wrangler_raw_log"
  rm -rf -- "$state_dir"
}
trap cleanup EXIT

start_worker() {
  npm_config_ignore_scripts=true npx --yes wrangler@4.107.0 dev \
    --config dashboard/wrangler.toml \
    --local \
    --persist-to "$state_dir" \
    --ip 127.0.0.1 \
    --port "$worker_port" \
    --var "CLAWSWEEPER_WEBHOOK_SECRET:${proof_secret}" \
    >>"$wrangler_raw_log" 2>&1 &
  wrangler_pid=$!

  local ready=false
  for _ in $(seq 1 90); do
    if curl --fail --silent "http://127.0.0.1:${worker_port}/api/health" >/dev/null 2>&1; then
      ready=true
      break
    fi
    if ! kill -0 "$wrangler_pid" >/dev/null 2>&1; then
      sed -n '1,240p' "$wrangler_raw_log" >&2
      exit 1
    fi
    sleep 1
  done
  test "$ready" = true
}

http_status() {
  local output_file="$1"
  shift
  curl --silent --show-error --max-time 90 --output "$output_file" --write-out '%{http_code}' "$@"
}

pnpm install --frozen-lockfile >"${output_dir}/dependencies-install.log" 2>&1
pnpm run build:dashboard >"${output_dir}/build-dashboard.log" 2>&1

# Initialize the real local Durable Object database, then stop Wrangler so the
# pre-upgrade table can be seeded into its persisted SQLite state.
start_worker
initial_queue_status="$(http_status "${output_dir}/initial-queue.json" \
  "http://127.0.0.1:${worker_port}/api/exact-review-queue")"
test "$initial_queue_status" = "200"
stop_worker

while IFS= read -r candidate; do
  candidate_has_run_table="$(node "$sqlite_helper" has-run-table "$candidate")"
  if test "$candidate_has_run_table" = "1"; then
    queue_db="$candidate"
    break
  fi
done < <(find "$state_dir" -type f -name '*.sqlite' -print)
test -n "$queue_db"

node "$sqlite_helper" seed-legacy-schema "$queue_db"

node "$sqlite_helper" list-retired-schema "$queue_db" \
  >"${output_dir}/retired-schema-before.txt"
test "$(wc -l <"${output_dir}/retired-schema-before.txt" | tr -d ' ')" = "4"

# Reboot the current Worker against the persisted legacy schema. The signed
# run-telemetry write must reach the Durable Object, so use it to force
# initialization before making any upgrade assertions.
start_worker
run_record="${output_dir}/run-telemetry-record.json"
node -e '
  const fs = require("node:fs");
  const completed = new Date();
  const started = new Date(completed.getTime() - 60_000);
  const runId = process.argv[2];
  fs.writeFileSync(process.argv[1], JSON.stringify({
    run_id: runId,
    run_attempt: 1,
    workflow_outcome: "success",
    trigger_lane: "normal_backfill",
    trigger_origin: "schedule",
    target_repo: "openclaw/openclaw",
    started_at: started.toISOString(),
    completed_at: completed.toISOString(),
    run_url: `https://github.com/openclaw/clawsweeper/actions/runs/${runId}`,
    plan_count: 1,
    item_count: 3,
    publication_count: 1
  }));
' "$run_record" "$proof_run_id"
run_signature="$(openssl dgst -sha256 -hmac "$proof_secret" -hex <"$run_record" | awk '{print $NF}')"
run_post_status="$(http_status "${output_dir}/run-telemetry-post.json" \
  -X POST \
  -H "content-type: application/json" \
  -H "x-clawsweeper-exact-review-signature: sha256=${run_signature}" \
  --data-binary "@${run_record}" \
  "http://127.0.0.1:${worker_port}/internal/exact-review/review-run-telemetry")"
test "$run_post_status" = "200"

# Drive the remaining assertions over the real HTTP surface.
upgrade_queue_status="$(http_status "${output_dir}/queue-after-upgrade.json" \
  "http://127.0.0.1:${worker_port}/api/exact-review-queue")"
health_status="$(http_status "${output_dir}/health.json" \
  "http://127.0.0.1:${worker_port}/api/health")"
status_status="$(http_status "${output_dir}/status.json" \
  "http://127.0.0.1:${worker_port}/api/status")"
test "$upgrade_queue_status" = "200"
test "$health_status" = "200"
test "$status_status" = "200"

node -e '
  const fs = require("node:fs");
  const health = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const status = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  if (health.ok !== true) process.exit(1);
  if (!status.exact_review_queue || Object.hasOwn(status.exact_review_queue, "review_telemetry_health")) process.exit(1);
' "${output_dir}/health.json" "${output_dir}/status.json"

observability_status="$(http_status "${output_dir}/review-observability.json" \
  "http://127.0.0.1:${worker_port}/api/review-observability?range=24h&repo=all")"
test "$observability_status" = "200"

node -e '
  const fs = require("node:fs");
  const posted = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const body = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const expectedKeys = ["generated_at", "health", "mode", "range", "reasons", "repo", "sources", "telemetry_complete"];
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(expectedKeys)) process.exit(1);
  const expectedLanes = ["exact_event", "hot_intake", "normal_backfill", "recovery"];
  if (JSON.stringify(body.sources.map((source) => source.lane)) !== JSON.stringify(expectedLanes)) process.exit(1);
  const lane = body.sources.find((source) => source.lane === "normal_backfill");
  if (!lane || lane.run_count !== 1 || lane.item_count !== 3 || lane.last_run_at !== posted.completed_at) process.exit(1);
' "$run_record" "${output_dir}/review-observability.json"

removed_body='{}'
removed_signature="$(printf '%s' "$removed_body" | openssl dgst -sha256 -hmac "$proof_secret" -hex | awk '{print $NF}')"
removed_post_status="$(http_status "${output_dir}/removed-review-telemetry-post.txt" \
  -X POST \
  -H "content-type: application/json" \
  -H "x-clawsweeper-exact-review-signature: sha256=${removed_signature}" \
  --data-binary "$removed_body" \
  "http://127.0.0.1:${worker_port}/internal/exact-review/review-telemetry")"
reviews_get_status="$(http_status "${output_dir}/reviews-get.txt" \
  "http://127.0.0.1:${worker_port}/api/exact-review-queue/reviews?repo=openclaw%2Fopenclaw&item_number=674")"
test "$removed_post_status" = "404"
test "$reviews_get_status" = "200"
node -e '
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  assert.deepEqual(body, {
    ok: true,
    repo: "openclaw/openclaw",
    item_number: 674,
    reviews: [],
  });
' "${output_dir}/reviews-get.txt"

stop_worker
node "$sqlite_helper" assert-proof-run-record "$queue_db" "$proof_run_id"
node "$sqlite_helper" list-retired-schema "$queue_db" \
  >"${output_dir}/retired-schema-after.txt"
test ! -s "${output_dir}/retired-schema-after.txt"
run_table_count="$(node "$sqlite_helper" has-run-table "$queue_db")"
test "$run_table_count" = "1"
if grep -Eiq 'SQLITE_ERROR|no such table|schema error' "$wrangler_raw_log"; then
  sed -n '1,240p' "$wrangler_raw_log" >&2
  exit 1
fi

UPGRADE_QUEUE_STATUS="$upgrade_queue_status" \
STATUS_STATUS="$status_status" \
HEALTH_STATUS="$health_status" \
RUN_POST_STATUS="$run_post_status" \
PROOF_RUN_ID="$proof_run_id" \
OBSERVABILITY_STATUS="$observability_status" \
REMOVED_POST_STATUS="$removed_post_status" \
REVIEWS_GET_STATUS="$reviews_get_status" \
node -e '
  const fs = require("node:fs");
  const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const lane = body.sources.find((source) => source.lane === "normal_backfill");
  const lines = [
    "legacy schema before upgrade: table plus three indexes present",
    "upgrade queue request: HTTP " + process.env.UPGRADE_QUEUE_STATUS + "; schema errors: none",
    "legacy schema after upgrade: exact_review_review_telemetry table and indexes absent",
    "/api/status: HTTP " + process.env.STATUS_STATUS + "; exact_review_queue.review_telemetry_health absent",
    "/api/health: HTTP " + process.env.HEALTH_STATUS + "; ok true",
    "POST /internal/exact-review/review-run-telemetry: HTTP " + process.env.RUN_POST_STATUS,
    "/api/review-observability: HTTP " + process.env.OBSERVABILITY_STATUS + "; lanes exact_event,hot_intake,normal_backfill,recovery; normal_backfill run_count " + lane.run_count + "; item_count " + lane.item_count + "; last_run_at " + lane.last_run_at,
    "POST /internal/exact-review/review-telemetry: HTTP " + process.env.REMOVED_POST_STATUS,
    "GET /api/exact-review-queue/reviews: HTTP " + process.env.REVIEWS_GET_STATUS + "; envelope { ok: true, repo: openclaw/openclaw, item_number: 674, reviews: [] }",
    "run-level storage after upgrade: exact_review_run_telemetry present; posted run_id " + process.env.PROOF_RUN_ID + " present in inspected queue database"
  ];
  fs.writeFileSync(process.argv[2], lines.join("\n") + "\n");
' "${output_dir}/review-observability.json" "${output_dir}/runtime-transcript.txt"

test -s "${output_dir}/runtime-transcript.txt"
cat "${output_dir}/runtime-transcript.txt"
