#!/usr/bin/env bash
set -euo pipefail

expected_head="${1:-}"
if test -n "$expected_head" && test "$(git rev-parse HEAD)" != "$expected_head"; then
  echo "proof checkout does not match expected head" >&2
  exit 1
fi

output_path="${REVIEW_FAILURE_TELEMETRY_PROOF_OUTPUT:-docs/proof/review-failure-telemetry/result.json}"
tool_bin="$PWD/.artifacts/review-failure-telemetry-bin"
if ! command -v pnpm >/dev/null 2>&1; then
  mkdir -p "$tool_bin"
  corepack enable --install-directory "$tool_bin"
  export PATH="$tool_bin:$PATH"
fi
pnpm install --frozen-lockfile
pnpm run build:all
REVIEW_FAILURE_TELEMETRY_PROOF_OUTPUT="$output_path" \
  node --experimental-strip-types docs/proof/review-failure-telemetry/run-proof.mjs
