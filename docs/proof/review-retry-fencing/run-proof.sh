#!/usr/bin/env bash
set -euo pipefail

expected_head="${1:-}"
if test -n "$expected_head" && git rev-parse --git-dir >/dev/null 2>&1 && \
  test "$(git rev-parse HEAD)" != "$expected_head"; then
  echo "proof checkout does not match expected head" >&2
  exit 1
fi

output_path="${REVIEW_RETRY_FENCING_PROOF_OUTPUT:-.artifacts/review-retry-fencing/result.json}"
tool_bin="$PWD/.artifacts/review-retry-fencing-bin"
if ! command -v pnpm >/dev/null 2>&1; then
  mkdir -p "$tool_bin"
  corepack enable --install-directory "$tool_bin"
  export PATH="$tool_bin:$PATH"
fi
pnpm install --frozen-lockfile
pnpm run build:all
REVIEW_RETRY_FENCING_SOURCE_HEAD="$expected_head" \
  REVIEW_RETRY_FENCING_PROOF_OUTPUT="$output_path" \
  node --experimental-strip-types docs/proof/review-retry-fencing/run-proof.mjs
