#!/usr/bin/env bash
set -euo pipefail

proof_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
jq_version="1.8.2"
jq_asset="jq-linux-amd64"
tool_dir="$(mktemp -d /tmp/apply-cursor-proof-tools.XXXXXX)"
trap 'rm -rf "$tool_dir"' EXIT

curl --fail --silent --show-error --location \
  "https://github.com/jqlang/jq/releases/download/jq-${jq_version}/${jq_asset}" \
  --output "$tool_dir/jq"
curl --fail --silent --show-error --location \
  "https://github.com/jqlang/jq/releases/download/jq-${jq_version}/sha256sum.txt" \
  --output "$tool_dir/sha256sum.txt"
expected="$(awk -v asset="$jq_asset" '$2 == asset { print $1 }' "$tool_dir/sha256sum.txt")"
actual="$(sha256sum "$tool_dir/jq" | awk '{ print $1 }')"
test -n "$expected"
test "$actual" = "$expected"
chmod +x "$tool_dir/jq"
export PATH="$tool_dir:$PATH"

echo "JQ_ASSET=$jq_asset"
echo "JQ_SHA256=$actual"
echo "JQ_CHECKSUM_VERIFIED=true"
"$proof_dir/run-proof.sh"
