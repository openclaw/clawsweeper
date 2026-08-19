#!/usr/bin/env bash
set -euo pipefail

expected_head=${1:?expected committed head argument is required}
expected_base=${2:?expected merge-base argument is required}
proof_rc=0
trap 'proof_rc=$?; echo "PROOF_RC=$proof_rc"' EXIT

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  source_bundle="docs/proof/dashboard-strict-slice-2/source.bundle"
  test -f "$source_bundle"
  git init
  git bundle verify "$source_bundle"
  git bundle unbundle "$source_bundle"
  git update-ref refs/heads/steipete/dashboard-strict-slice-2 "$expected_head"
  git update-ref refs/remotes/origin/main "$expected_base"
  git symbolic-ref HEAD refs/heads/steipete/dashboard-strict-slice-2
  git reset --mixed "$expected_head"
fi

proof_head="$(git rev-parse HEAD)"
proof_base="$(git merge-base HEAD origin/main)"
test "$proof_head" = "$expected_head"
test "$proof_base" = "$expected_base"
test -z "$(git status --porcelain --untracked-files=no)"
git cat-file -e "$proof_head^{commit}"
git cat-file -e "$proof_base^{commit}"
echo "PROOF_RECEIPT=COMMITTED"
echo "PROOF_HEAD=$proof_head"
echo "PROOF_MERGE_BASE=$proof_base"

proof_bin="$HOME/.local/bin"
mkdir -p "$proof_bin"
jq_version="1.8.1"
case "$(uname -m)" in
  x86_64) jq_asset="jq-linux-amd64" ;;
  aarch64 | arm64) jq_asset="jq-linux-arm64" ;;
  *) echo "unsupported jq architecture: $(uname -m)" >&2; exit 1 ;;
esac
jq_dir="$(mktemp -d)"
curl --fail --show-error --silent --location \
  "https://github.com/jqlang/jq/releases/download/jq-${jq_version}/${jq_asset}" \
  --output "$jq_dir/$jq_asset"
curl --fail --show-error --silent --location \
  "https://github.com/jqlang/jq/releases/download/jq-${jq_version}/sha256sum.txt" \
  --output "$jq_dir/sha256sum.txt"
(cd "$jq_dir" && grep " ${jq_asset}$" sha256sum.txt | sha256sum --check -)
install -m 0755 "$jq_dir/$jq_asset" "$proof_bin/jq"
rm -rf "$jq_dir"
npm install --global --prefix "$HOME/.local" corepack@0.35.0
corepack enable --install-directory "$proof_bin"
export PATH="$proof_bin:$PATH"
jq --version
pnpm install --frozen-lockfile
pnpm run check:dashboard-strict
node --test test/check-dashboard-strict.test.ts
pnpm run check
node docs/proof/dashboard-strict-slice-2/run-proof.mjs
