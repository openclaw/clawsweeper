#!/usr/bin/env bash
set -euo pipefail

proof_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "$proof_dir" rev-parse --show-toplevel)"
artifact_dir="${UNIFY_GITHUB_APP_AUTH_PROOF_OUTPUT:-$proof_dir/artifacts}"

finish() {
  local proof_rc=$?
  echo "PROOF_RC=$proof_rc"
}
trap finish EXIT

cd "$repo_root"
mkdir -p "$artifact_dir"

export CI=1
export WRANGLER_SEND_METRICS=false
export PNPM_HOME="${PNPM_HOME:-$HOME/.local/bin}"
mkdir -p "$PNPM_HOME"
export PATH="$PNPM_HOME:$PATH"
if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable --install-directory "$PNPM_HOME"
fi

echo "node=$(node --version)"
echo "pnpm=$(pnpm --version)"
echo "head=$(git rev-parse HEAD)"

pnpm install --frozen-lockfile >"$artifact_dir/dependencies-install.log" 2>&1
pnpm run build:dashboard >"$artifact_dir/build-dashboard.log" 2>&1
UNIFY_GITHUB_APP_AUTH_PROOF_OUTPUT="$artifact_dir" \
  node "$proof_dir/run-proof.mjs"
