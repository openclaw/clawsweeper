#!/usr/bin/env bash
set -euo pipefail

export CI=1
export WRANGLER_SEND_METRICS=false

output_dir="${DIRECT_PUBLICATION_REJECT_DETAIL_PROOF_OUTPUT:-docs/proof/direct-publication-reject-detail/artifacts}"
worker_port="${DIRECT_PUBLICATION_REJECT_DETAIL_PROOF_PORT:-8797}"
proof_secret="direct-publication-reject-detail-disposable-local-secret"
sqlite_helper="docs/proof/direct-publication-reject-detail/assert-durable-object.mjs"
state_dir="$(mktemp -d /tmp/direct-publication-reject-detail-state.XXXXXX)"
wrangler_raw_log="$(mktemp /tmp/direct-publication-reject-detail-wrangler.XXXXXX)"
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

signed_post() {
  local body_file="$1"
  local output_file="$2"
  local signature
  signature="$(openssl dgst -sha256 -hmac "$proof_secret" -hex <"$body_file" | awk '{print $NF}')"
  http_status "$output_file" \
    -X POST \
    -H "content-type: application/json" \
    -H "x-clawsweeper-exact-review-signature: sha256=${signature}" \
    --data-binary "@${body_file}" \
    "http://127.0.0.1:${worker_port}/internal/exact-review/publication-results"
}

pnpm install --frozen-lockfile >"${output_dir}/dependencies-install.log" 2>&1
pnpm run build:dashboard >"${output_dir}/build-dashboard.log" 2>&1

# Force the real Durable Object to initialize, then stop the entire Wrangler
# process tree before inspecting its persisted schema.
start_worker
initial_queue_status="$(http_status "${output_dir}/initial-queue.json" \
  "http://127.0.0.1:${worker_port}/api/exact-review-queue")"
test "$initial_queue_status" = "200"
stop_worker

while IFS= read -r candidate; do
  if test "$(node "$sqlite_helper" "$candidate")" = "1"; then
    queue_db="$candidate"
    break
  fi
done < <(find "$state_dir" -type f -name '*.sqlite' -print)
if test -z "$queue_db"; then
  echo "Durable Object did not initialize: direct publication table is absent" >&2
  exit 1
fi

node -e '
  const fs = require("node:fs");
  const base = {
    canonicalTargetKey: "steipete/CodexBar#2797",
    fenceKey: "steipete/CodexBar#2797",
    sourceSha: "a".repeat(40),
    operations: [{
      path: "records/steipete-CodexBar/items/2797.md",
      deleted: false,
      mode: "100644",
      bytes: 1,
      contentBase64: "eA==",
    }],
    totalBytes: 1,
    lifecycle: { kind: "policy_noop" },
  };
  const invalidRevision = {
    ...base,
    revision: 0,
    identity: {
      canonicalTargetKey: base.canonicalTargetKey,
      fenceKey: base.fenceKey,
      revision: 0,
      claimGeneration: 1,
    },
  };
  const outsidePath = {
    ...base,
    revision: 1,
    identity: {
      canonicalTargetKey: base.canonicalTargetKey,
      fenceKey: base.fenceKey,
      revision: 1,
      claimGeneration: 1,
    },
    operations: [{ ...base.operations[0], path: "records/steipete-CodexBar/items/2798.md" }],
  };
  fs.writeFileSync(process.argv[1], JSON.stringify(invalidRevision));
  fs.writeFileSync(process.argv[2], JSON.stringify(outsidePath));
' "${output_dir}/invalid-revision-request.json" "${output_dir}/outside-path-request.json"

start_worker
revision_status="$(signed_post \
  "${output_dir}/invalid-revision-request.json" \
  "${output_dir}/invalid-revision-response.json")"
path_status="$(signed_post \
  "${output_dir}/outside-path-request.json" \
  "${output_dir}/outside-path-response.json")"
test "$revision_status" = "400"
test "$path_status" = "400"

REVISION_STATUS="$revision_status" PATH_STATUS="$path_status" node -e '
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const revision = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const outsidePath = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  for (const body of [revision, outsidePath]) {
    assert.equal(body.error, "invalid_direct_publication_plan");
    assert.equal(body.fallback_required, true);
    assert.equal(typeof body.detail, "string");
    assert.ok(body.detail.length > 0);
  }
  assert.match(revision.detail, /invalid direct publication revision/);
  assert.match(outsidePath.detail, /direct publication path is outside steipete-CodexBar#2797/);
  assert.notEqual(revision.detail, outsidePath.detail);
  const lines = [
    "Durable Object initialized: exact_review_direct_publication_plans table present",
    "invalid revision: HTTP " + process.env.REVISION_STATUS + "; error=" + revision.error + "; fallback_required=" + revision.fallback_required + "; detail=" + revision.detail,
    "outside path: HTTP " + process.env.PATH_STATUS + "; error=" + outsidePath.error + "; fallback_required=" + outsidePath.fallback_required + "; detail=" + outsidePath.detail,
    "distinct validation details: true",
  ];
  fs.writeFileSync(process.argv[3], lines.join("\n") + "\n");
' \
  "${output_dir}/invalid-revision-response.json" \
  "${output_dir}/outside-path-response.json" \
  "${output_dir}/runtime-transcript.txt"

test -s "${output_dir}/runtime-transcript.txt"
cat "${output_dir}/runtime-transcript.txt"
