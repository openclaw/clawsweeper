#!/usr/bin/env bash
set -euo pipefail

proof_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "$proof_dir" rev-parse --show-toplevel)"

finish() {
  local proof_rc=$?
  echo "PROOF_RC=$proof_rc"
}
trap finish EXIT

cd "$repo_root"
export CI=1
export PNPM_HOME="${PNPM_HOME:-$HOME/.local/bin}"
mkdir -p "$PNPM_HOME"
export PATH="$PNPM_HOME:$PATH"
if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable --install-directory "$PNPM_HOME"
fi

echo "node=$(node --version)"
echo "pnpm=$(pnpm --version)"
echo "jq=$(jq --version)"
echo "head=$(git rev-parse HEAD)"

pnpm install --frozen-lockfile
pnpm run build:all
node "$proof_dir/run-proof.mjs"
node --test \
  --test-name-pattern='urgent all-item repair|comment sync advances a completed frontier|wrapped cursor synchronization|wrapped urgent comment-sync batches' \
  test/repair/workflow-utils.test.ts test/sweep-workflow.test.ts

echo "APPLY_CURSOR_PROOF_OK"
