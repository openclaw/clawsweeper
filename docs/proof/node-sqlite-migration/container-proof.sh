#!/usr/bin/env bash
set -euo pipefail

echo "CONTAINER_PHASE=environment"
node --version
corepack pnpm --version
if command -v sqlite3 >/dev/null 2>&1; then
  echo "unexpected sqlite3 binary: $(command -v sqlite3)" >&2
  exit 1
fi
echo "SQLITE3_BINARY=absent"

jq_version="1.8.2"
case "$(uname -m)" in
  x86_64) jq_asset="jq-linux-amd64" ;;
  aarch64|arm64) jq_asset="jq-linux-arm64" ;;
  *) echo "unsupported jq architecture: $(uname -m)" >&2; exit 1 ;;
esac
jq_dir="$(mktemp -d)"
trap 'rm -rf "$jq_dir"' EXIT
curl --fail --show-error --silent --location \
  "https://github.com/jqlang/jq/releases/download/jq-${jq_version}/${jq_asset}" \
  --output "${jq_dir}/${jq_asset}"
curl --fail --show-error --silent --location \
  "https://github.com/jqlang/jq/releases/download/jq-${jq_version}/sha256sum.txt" \
  --output "${jq_dir}/sha256sum.txt"
(cd "$jq_dir" && grep " ${jq_asset}$" sha256sum.txt | sha256sum --check -)
install -m 0755 "${jq_dir}/${jq_asset}" /usr/local/bin/jq
jq --version

echo "CONTAINER_PHASE=install"
corepack enable
pnpm install --frozen-lockfile

echo "CONTAINER_PHASE=focused-new-path"
pnpm run build:all
node --test test/repair/gitcrawl-sqlite.test.ts

echo "CONTAINER_PHASE=full-suite"
pnpm run check

echo "CONTAINER_PROOF_RC=0"
