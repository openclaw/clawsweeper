#!/usr/bin/env bash
set -euo pipefail

export CI=1
export WRANGLER_SEND_METRICS=false

output_dir="${MIXED_CASE_PUBLICATION_SLUGS_PROOF_OUTPUT:-docs/proof/mixed-case-publication-slugs/artifacts}"
worker_port="${MIXED_CASE_PUBLICATION_SLUGS_PROOF_PORT:-8798}"
proof_secret="mixed-case-publication-slugs-disposable-local-secret"
proof_dir="docs/proof/mixed-case-publication-slugs"
state_dir="$(mktemp -d /tmp/mixed-case-publication-slugs-state.XXXXXX)"
wrangler_raw_log="$(mktemp /tmp/mixed-case-publication-slugs-wrangler.XXXXXX)"
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
  local endpoint="${3:-/internal/exact-review/publication-results}"
  local signature
  signature="$(openssl dgst -sha256 -hmac "$proof_secret" -hex <"$body_file" | awk '{print $NF}')"
  http_status "$output_file" \
    -X POST \
    -H "content-type: application/json" \
    -H "x-clawsweeper-exact-review-signature: sha256=${signature}" \
    --data-binary "@${body_file}" \
    "http://127.0.0.1:${worker_port}${endpoint}"
}

pnpm install --frozen-lockfile >"${output_dir}/dependencies-install.log" 2>&1
pnpm run build:dashboard >"${output_dir}/build-dashboard.log" 2>&1

start_worker
initial_queue_status="$(http_status "${output_dir}/initial-queue.json" \
  "http://127.0.0.1:${worker_port}/api/exact-review-queue")"
test "$initial_queue_status" = "200"
stop_worker

while IFS= read -r candidate; do
  if test "$(node "${proof_dir}/assert-durable-object.mjs" "$candidate")" = "1"; then
    queue_db="$candidate"
    break
  fi
done < <(find "$state_dir" -type f -name '*.sqlite' -print)
if test -z "$queue_db"; then
  echo "Durable Object did not initialize: direct publication table is absent" >&2
  exit 1
fi
node "${proof_dir}/seed-publication-fences.mjs" "$queue_db"

node -e '
  const fs = require("node:fs");
  const plan = (key, path) => ({
    canonicalTargetKey: key,
    fenceKey: key,
    sourceSha: "a".repeat(40),
    revision: 1,
    identity: {
      canonicalTargetKey: key,
      fenceKey: key,
      revision: 1,
      claimGeneration: 1,
    },
    operations: [{
      path,
      deleted: false,
      mode: "100644",
      bytes: 1,
      contentBase64: "eA==",
    }],
    totalBytes: 1,
    lifecycle: { kind: "policy_noop" },
  });
  fs.writeFileSync(
    process.argv[1],
    JSON.stringify(plan("steipete/CodexBar#2516", "records/steipete-CodexBar/items/2516.md")),
  );
  fs.writeFileSync(
    process.argv[2],
    JSON.stringify(plan("steipete/CodexBar#2517", "records/steipete-other/items/2517.md")),
  );
  fs.writeFileSync(
    process.argv[3],
    JSON.stringify(plan("openclaw/openclaw#806", "records/openclaw-openclaw/items/806.md")),
  );
  fs.writeFileSync(
    process.argv[4],
    JSON.stringify({
      repoSlug: "steipete-codexbar",
      sections: ["items"],
      sinceRevision: 0,
      cursor: 0,
      limit: 100,
    }),
  );
  fs.writeFileSync(
    process.argv[5],
    JSON.stringify({
      repoSlug: "steipete-CodexBar",
      sections: ["items"],
      sinceRevision: 0,
      cursor: 0,
      limit: 100,
    }),
  );
' \
  "${output_dir}/mixed-case-request.json" \
  "${output_dir}/different-repository-request.json" \
  "${output_dir}/lowercase-request.json" \
  "${output_dir}/lowercase-export-request.json" \
  "${output_dir}/uppercase-export-request.json"

start_worker
mixed_status="$(signed_post \
  "${output_dir}/mixed-case-request.json" \
  "${output_dir}/mixed-case-response.json")"
different_status="$(signed_post \
  "${output_dir}/different-repository-request.json" \
  "${output_dir}/different-repository-response.json")"
lowercase_status="$(signed_post \
  "${output_dir}/lowercase-request.json" \
  "${output_dir}/lowercase-response.json")"
lowercase_export_status="$(signed_post \
  "${output_dir}/lowercase-export-request.json" \
  "${output_dir}/lowercase-export-response.json" \
  "/internal/state/records/export")"
uppercase_export_status="$(signed_post \
  "${output_dir}/uppercase-export-request.json" \
  "${output_dir}/uppercase-export-response.json" \
  "/internal/state/records/export")"
test "$mixed_status" = "202"
test "$different_status" = "400"
test "$lowercase_status" = "202"
test "$lowercase_export_status" = "200"
test "$uppercase_export_status" = "200"

MIXED_STATUS="$mixed_status" DIFFERENT_STATUS="$different_status" LOWERCASE_STATUS="$lowercase_status" \
  LOWERCASE_EXPORT_STATUS="$lowercase_export_status" UPPERCASE_EXPORT_STATUS="$uppercase_export_status" \
  node -e '
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const mixed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const different = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const lowercase = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
    const lowercaseExport = JSON.parse(fs.readFileSync(process.argv[4], "utf8"));
    const uppercaseExport = JSON.parse(fs.readFileSync(process.argv[5], "utf8"));
    for (const body of [mixed, lowercase]) {
      assert.equal(body.ok, true);
      assert.equal(body.accepted || body.deduped, true);
    }
    assert.equal(mixed.canonical_target_key, "steipete/CodexBar#2516");
    assert.equal(lowercase.canonical_target_key, "openclaw/openclaw#806");
    assert.equal(lowercaseExport.repoSlug, "steipete-codexbar");
    assert.equal(lowercaseExport.records.length, 1);
    assert.equal(lowercaseExport.records[0].section, "items");
    assert.equal(lowercaseExport.records[0].id, "2516");
    assert.equal(lowercaseExport.records[0].content, "x");
    assert.equal(uppercaseExport.repoSlug, "steipete-CodexBar");
    assert.deepEqual(uppercaseExport.records, []);
    assert.equal(different.error, "invalid_direct_publication_plan");
    assert.equal(different.fallback_required, true);
    assert.match(
      different.detail,
      /direct publication path is outside steipete-CodexBar#2517: records\/steipete-other\/items\/2517\.md/,
    );
    const lines = [
      "Durable Object initialized: exact_review_direct_publication_plans table present",
      "mixed-case repository with uppercase path: HTTP " + process.env.MIXED_STATUS + "; accepted=" + mixed.accepted + "; deduped=" + mixed.deduped + "; canonical_target_key=" + mixed.canonical_target_key,
      "different repository: HTTP " + process.env.DIFFERENT_STATUS + "; error=" + different.error + "; fallback_required=" + different.fallback_required + "; detail=" + different.detail,
      "lowercase repository: HTTP " + process.env.LOWERCASE_STATUS + "; accepted=" + lowercase.accepted + "; deduped=" + lowercase.deduped + "; canonical_target_key=" + lowercase.canonical_target_key,
      "lowercase namespace export: HTTP " + process.env.LOWERCASE_EXPORT_STATUS + "; records=" + lowercaseExport.records.length + "; content=" + lowercaseExport.records[0].content,
      "uppercase namespace export: HTTP " + process.env.UPPERCASE_EXPORT_STATUS + "; records=" + uppercaseExport.records.length,
    ];
    fs.writeFileSync(process.argv[6], lines.join("\n") + "\n");
  ' \
  "${output_dir}/mixed-case-response.json" \
  "${output_dir}/different-repository-response.json" \
  "${output_dir}/lowercase-response.json" \
  "${output_dir}/lowercase-export-response.json" \
  "${output_dir}/uppercase-export-response.json" \
  "${output_dir}/runtime-transcript.txt"

stop_worker
node "${proof_dir}/assert-durable-object.mjs" "$queue_db" canonical-namespace \
  >"${output_dir}/namespace-storage.json"
cat "${output_dir}/namespace-storage.json" >>"${output_dir}/runtime-transcript.txt"

test -s "${output_dir}/runtime-transcript.txt"
cat "${output_dir}/runtime-transcript.txt"
