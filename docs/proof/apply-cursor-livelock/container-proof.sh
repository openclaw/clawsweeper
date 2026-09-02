#!/usr/bin/env bash
set -euo pipefail

proof_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$proof_dir/../../.." && pwd)"
jq_version="1.8.2"
jq_asset="jq-linux-amd64"
jq_sha256="b1c22172dd303f3be49e935aa56aa48a8b7a46e0bc838b4997d3bb451495870f"
tool_dir="$(mktemp -d /tmp/apply-cursor-proof-tools.XXXXXX)"
trap 'rm -rf "$tool_dir"' EXIT

curl --fail --silent --show-error --location \
  "https://github.com/jqlang/jq/releases/download/jq-${jq_version}/${jq_asset}" \
  --output "$tool_dir/jq"
actual="$(sha256sum "$tool_dir/jq" | awk '{ print $1 }')"
test "$actual" = "$jq_sha256"
install -m 0755 "$tool_dir/jq" /usr/local/bin/jq
export PATH="/usr/local/bin:$PATH"
git config --global --add safe.directory "$repo_root"

echo "JQ_ASSET=$jq_asset"
echo "JQ_SHA256=$actual"
echo "JQ_CHECKSUM_VERIFIED=true"
echo "JQ_INSTALL_PATH=/usr/local/bin/jq"
"$proof_dir/run-proof.sh"
