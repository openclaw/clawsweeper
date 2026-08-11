#!/usr/bin/env bash
set -euo pipefail

proof_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "$proof_dir" rev-parse --show-toplevel)"
artifact_dir="${EXTRACT_DASHBOARD_PAGES_PROOF_OUTPUT:-$proof_dir/artifacts}"
temp_dir="$(mktemp -d /tmp/extract-dashboard-pages-proof.XXXXXX)"
base_root="$temp_dir/base"
capture_root="$temp_dir/captures"
port=18790
worker_pid=""

cleanup() {
  local proof_rc=$?
  if test -n "$worker_pid"; then
    kill "$worker_pid" >/dev/null 2>&1 || true
    wait "$worker_pid" >/dev/null 2>&1 || true
  fi
  git -C "$repo_root" worktree remove --force "$base_root" >/dev/null 2>&1 || true
  rm -rf -- "$temp_dir"
  echo "PROOF_RC=$proof_rc"
}
trap cleanup EXIT

cd "$repo_root"
for command_name in curl git node pnpm; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "required command not found: $command_name" >&2
    exit 1
  }
done

mkdir -p "$artifact_dir" "$capture_root/before" "$capture_root/after"
head_sha="$(git rev-parse HEAD)"
base_sha="$(git merge-base origin/main HEAD)"
git worktree add --detach "$base_root" "$base_sha" >/dev/null
ln -s "$repo_root/node_modules" "$base_root/node_modules"

echo "node=$(node --version)"
echo "pnpm=$(pnpm --version)"
echo "base_sha=$base_sha"
echo "head_sha=$head_sha"

start_worker() {
  local root=$1
  local log=$2
  (
    cd "$root"
    exec npx wrangler@4.107.0 dev --config dashboard/wrangler.toml --port "$port"
  ) >"$log" 2>&1 &
  worker_pid=$!
  for _attempt in $(seq 1 60); do
    if curl --fail --silent --output /dev/null "http://127.0.0.1:$port/"; then
      return 0
    fi
    if ! kill -0 "$worker_pid" >/dev/null 2>&1; then
      echo "Worker exited before becoming ready" >&2
      return 1
    fi
    sleep 0.25
  done
  echo "Worker did not become ready" >&2
  return 1
}

stop_worker() {
  kill "$worker_pid" >/dev/null 2>&1 || true
  wait "$worker_pid" >/dev/null 2>&1 || true
  worker_pid=""
}

capture_pages() {
  local destination=$1
  curl --fail --silent --show-error --output "$destination/root.html" "http://127.0.0.1:$port/"
  curl --fail --silent --show-error --output "$destination/triage.html" "http://127.0.0.1:$port/triage"
  curl --fail --silent --show-error --output "$destination/pr-proof-triage.html" \
    "http://127.0.0.1:$port/pr-proof-triage"
}

echo "== base Worker =="
start_worker "$base_root" "$artifact_dir/base-worker.log"
capture_pages "$capture_root/before"
stop_worker

echo "== head Worker =="
start_worker "$repo_root" "$artifact_dir/head-worker.log"
capture_pages "$capture_root/after"

validator_dir="$(mktemp -d "$temp_dir/behavior-validator.XXXXXX")"
cp "$proof_dir/behavior-contract.md" "$proof_dir/behavior-validate.mjs" "$validator_dir/"
(
  cd "$validator_dir"
  node behavior-validate.mjs "http://127.0.0.1:$port" "$artifact_dir/behavior-validation.json"
)
stop_worker

node "$proof_dir/compare-pages.mjs" "$capture_root" "$artifact_dir" "$base_sha" "$head_sha"
node - "$artifact_dir/provenance.json" "$base_sha" "$head_sha" <<'EOF'
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const [output, baseSha, headSha] = process.argv.slice(2);
const command = (name, args) => execFileSync(name, args, { encoding: "utf8" }).trim();
const provenance = {
  schema: "clawsweeper-dashboard-page-extraction-provenance/v1",
  generated_at: new Date().toISOString(),
  base_sha: baseSha,
  head_sha: headSha,
  runtime: {
    platform: `${os.platform()} ${os.release()}`,
    architecture: os.arch(),
    node: process.version,
    pnpm: command("pnpm", ["--version"]),
    wrangler: "4.107.0",
  },
  routes: ["/", "/triage", "/pr-proof-triage"],
  result: { proof_rc: 0, normalized_diff_empty: true, behavior: "satisfies_contract" },
  limits: "Local Wrangler page-shell proof; no JSON API data, browser interaction, GitHub write, queue mutation, or production deployment.",
};
fs.writeFileSync(output, `${JSON.stringify(provenance, null, 2)}\n`);
EOF

echo "proof_result=passed"
