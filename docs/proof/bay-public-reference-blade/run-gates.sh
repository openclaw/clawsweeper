#!/usr/bin/env bash
set -euo pipefail

export CI=1
expected_sha="${BLADE_PROOF_SOURCE_SHA:-$(git rev-parse HEAD)}"
expected_tree="${BLADE_PROOF_TREE_SHA:?BLADE_PROOF_TREE_SHA is required}"
bundle_path="$(realpath "${BLADE_PROOF_BUNDLE:-bay-public-reference-blade.bundle}")"
exact_root="$(mktemp -d)"

# Crabbox syncs a raw Windows workspace without .git. Clone the host-generated
# bundle so Linux gates see the exact committed Git objects and LF tree.
cleanup() {
  rm -rf "$exact_root"
}
trap cleanup EXIT

git clone --quiet "$bundle_path" "$exact_root"
cd "$exact_root"
git bundle verify "$bundle_path"
git checkout --quiet --detach "$expected_sha"
test "$(git rev-parse HEAD)" = "$expected_sha"
test "$(git rev-parse 'HEAD^{tree}')" = "$expected_tree"
test -z "$(git status --porcelain)"

corepack_bin="${TMPDIR:-/tmp}/bay-public-reference-blade-corepack"
mkdir -p "$corepack_bin"
corepack enable --install-directory "$corepack_bin"
export PATH="$corepack_bin:$PATH"

pnpm install --frozen-lockfile
pnpm check
