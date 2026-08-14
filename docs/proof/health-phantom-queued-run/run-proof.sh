#!/usr/bin/env bash
set -euo pipefail

expected_head=${1:?expected committed head argument is required}
proof_root=docs/proof/health-phantom-queued-run
proof_prefix=/tmp/health-phantom-proof-prefix

echo "PROOF_PHASE=environment"
echo "provider=local-container"
echo "image=node:24-bookworm"
echo "expected_head=$expected_head"
node --version
npm --version

echo "PROOF_PHASE=git_identity"
actual_head=$(git rev-parse HEAD)
test "$actual_head" = "$expected_head"
git cat-file -e "$expected_head^{commit}"
echo "actual_head=$actual_head"

echo "PROOF_PHASE=corepack"
mkdir -p "$proof_prefix/bin"
npm install --global --prefix "$proof_prefix" corepack@0.35.0
export PATH="$proof_prefix/bin:$PATH"
corepack enable --install-directory "$proof_prefix/bin"
corepack pnpm --version

echo "PROOF_PHASE=install"
corepack pnpm install --frozen-lockfile

echo "PROOF_PHASE=focused_behavior"
corepack pnpm run build:all
node --test \
  test/github-webhook-read-model.test.ts \
  test/dashboard-operational-health.test.ts

echo "PROOF_PHASE=dashboard_strict"
corepack pnpm run check:dashboard-strict

echo "PROOF_PHASE=full_gate"
corepack pnpm run check

echo "PROOF_PHASE=static_json"
jq -e '
  .overall_behavior == "satisfies_contract" and
  ([.checks[].status] | all(. == "pass")) and
  (.blockers | length == 0)
' "$proof_root/behavior-report.json" >/dev/null

echo "PROOF_PHASE=committed_objects"
proof_files=(
  dashboard/github-webhook-read-model.ts
  dashboard/worker.ts
  docs/github-webhook-read-model.md
  docs/live-dashboard.md
  "$proof_root/README.md"
  "$proof_root/behavior-contract.md"
  "$proof_root/behavior-report.json"
  "$proof_root/red-green.md"
  "$proof_root/run-proof.sh"
  test/github-webhook-read-model.test.ts
)
for file in "${proof_files[@]}"; do
  git cat-file -e "$expected_head:$file"
  committed_blob=$(git rev-parse "$expected_head:$file")
  worktree_blob=$(git hash-object "$file")
  test "$committed_blob" = "$worktree_blob"
  printf 'blob=%s path=%s\n' "$committed_blob" "$file"
done

echo "PROOF_PHASE=content_sha256"
sha256sum "${proof_files[@]}"

echo "PROOF_RESULT=pass"
