#!/usr/bin/env bash
set -euo pipefail

proof_tmp="$(mktemp -d)"
trap 'rm -rf "$proof_tmp"' EXIT

jq_version="1.8.2"
case "$(uname -m)" in
  x86_64) jq_asset="jq-linux-amd64" ;;
  aarch64 | arm64) jq_asset="jq-linux-arm64" ;;
  *)
    echo "unsupported container architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

curl -fsSL "https://github.com/jqlang/jq/releases/download/jq-${jq_version}/sha256sum.txt" \
  -o "$proof_tmp/sha256sum.txt"
curl -fsSL "https://github.com/jqlang/jq/releases/download/jq-${jq_version}/${jq_asset}" \
  -o "$proof_tmp/$jq_asset"
(
  cd "$proof_tmp"
  sha256sum --ignore-missing --strict -c sha256sum.txt
)
chmod 0755 "$proof_tmp/$jq_asset"

corepack enable
pnpm install --frozen-lockfile

printf 'PROOF_HEAD=%s\n' "$(git rev-parse HEAD)"
printf 'PROOF_NODE=%s\n' "$(node --version)"
printf 'PROOF_PNPM=%s\n' "$(pnpm --version)"
printf 'PROOF_JQ=%s\n' "$("$proof_tmp/$jq_asset" --version)"
printf 'PROOF_JQ_ASSET=%s\n' "$jq_asset"
printf 'CRABBOX_PHASE:test\n'
pnpm test
printf 'SPLIT_DASHBOARD_WORKER_CONTAINER_PROOF_RC=0\n'
