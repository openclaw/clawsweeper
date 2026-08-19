#!/usr/bin/env bash
set -euo pipefail

proof_tmp="$(mktemp -d)"
trap 'rm -rf "$proof_tmp"' EXIT

jq_version="1.8.2"
case "$(uname -m)" in
  x86_64)
    jq_asset="jq-linux-amd64"
    jq_sha256="b1c22172dd303f3be49e935aa56aa48a8b7a46e0bc838b4997d3bb451495870f"
    ;;
  aarch64 | arm64)
    jq_asset="jq-linux-arm64"
    jq_sha256="8b85c817833814ddca00a144c33705546355afccf0cf39b188f3cdb48b852309"
    ;;
  *)
    echo "unsupported container architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

curl -fsSL "https://github.com/jqlang/jq/releases/download/jq-${jq_version}/${jq_asset}" \
  -o "$proof_tmp/$jq_asset"
printf '%s  %s\n' "$jq_sha256" "$jq_asset" > "$proof_tmp/sha256sum.txt"
(
  cd "$proof_tmp"
  sha256sum --ignore-missing --strict -c sha256sum.txt
)
chmod 0755 "$proof_tmp/$jq_asset"
install -m 0755 "$proof_tmp/$jq_asset" /usr/local/bin/jq
apt-get update
apt-get install -y --no-install-recommends rsync

corepack enable
pnpm install --frozen-lockfile

printf 'PROOF_HEAD=%s\n' "$(git -c safe.directory="$PWD" rev-parse HEAD)"
printf 'PROOF_NODE=%s\n' "$(node --version)"
printf 'PROOF_PNPM=%s\n' "$(pnpm --version)"
printf 'PROOF_JQ=%s\n' "$(jq --version)"
printf 'PROOF_JQ_ASSET=%s\n' "$jq_asset"
printf 'CRABBOX_PHASE:test\n'
pnpm test
printf 'SPLIT_DASHBOARD_WORKER_CONTAINER_PROOF_RC=0\n'
