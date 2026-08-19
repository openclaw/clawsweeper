#!/usr/bin/env bash
set -euo pipefail

node_version="24.19.0"
case "$(uname -m)" in
  aarch64 | arm64) node_arch="arm64" ;;
  x86_64 | amd64) node_arch="x64" ;;
  *)
    echo "unsupported container architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

tool_root="/tmp/clawsweeper-apply-read-generations"
node_archive="node-v${node_version}-linux-${node_arch}.tar.xz"
mkdir -p "$tool_root/node"

echo CRABBOX_PHASE:toolchain
sudo apt-get update -qq
sudo apt-get install -y -qq ca-certificates curl xz-utils
curl --fail --silent --show-error --location \
  "https://nodejs.org/dist/v${node_version}/${node_archive}" \
  --output "$tool_root/$node_archive"
curl --fail --silent --show-error --location \
  "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" \
  --output "$tool_root/SHASUMS256.txt"
(
  cd "$tool_root"
  grep " ${node_archive}$" SHASUMS256.txt | sha256sum --check --strict
)
tar -xJf "$tool_root/$node_archive" -C "$tool_root/node" --strip-components=1
export PATH="$tool_root/node/bin:$PATH"
node --version

echo CRABBOX_PHASE:install
corepack enable
pnpm install --frozen-lockfile

echo CRABBOX_PHASE:build
pnpm run build:all

echo CRABBOX_PHASE:source
[[ "${PROOF_SOURCE_HEAD:-}" =~ ^[0-9a-f]{40}$ ]]
[[ "${PROOF_SOURCE_TREE:-}" =~ ^[0-9a-f]{40}$ ]]
if git rev-parse --git-dir >/dev/null 2>&1; then
  test "$(git rev-parse HEAD)" = "$PROOF_SOURCE_HEAD"
  test "$(git rev-parse 'HEAD^{tree}')" = "$PROOF_SOURCE_TREE"
  git cat-file -e "${PROOF_SOURCE_HEAD}^{commit}"
  git cat-file -e "${PROOF_SOURCE_TREE}^{tree}"
else
  git init --quiet
  git config user.name "Crabbox Proof"
  git config user.email "crabbox-proof@localhost"
  git add --all
  git commit --quiet -m "test fixture baseline"
fi

echo CRABBOX_PHASE:proof
node scripts/e2e/apply-read-generations-loopback.mjs

echo CRABBOX_PHASE:check
pnpm run check
