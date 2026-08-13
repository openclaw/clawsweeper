#!/usr/bin/env bash
set -euo pipefail

# Windows OpenSSH/rsync can fail before Crabbox transfers any bytes. The
# local-container provider supports explicit read-only host bind mounts, so
# this wrapper snapshots the reviewed tree into Crabbox-managed writable work
# and runs the same proof without granting the container write access to the
# checkout.
source_dir=/mnt/csw-127-phase0-6-source
output_dir=/mnt/csw-127-phase0-6-output
mode=${1:-proof}
expected_tree=${2:-}

test -f "${source_dir}/pnpm-lock.yaml"
test -d "$output_dir"

if test -f "${output_dir}/source.tar"; then
  tar -xf "${output_dir}/source.tar"
else
  tar -C "$source_dir" \
    --exclude=./.artifacts \
    --exclude=./.crabbox \
    --exclude=./.git \
    --exclude=./dist \
    --exclude=./node_modules \
  -cf - . | tar -xf -
fi
rm -rf -- .crabbox

# Preserve a local immutable content identity for git-aware checks. This is a
# disposable container-only snapshot; it is never pushed or exposed publicly.
git init --quiet
git config user.name "CSW-127 proof"
git config user.email "csw-127-proof@invalid"
git config core.autocrlf false
# Force-add files that are intentionally tracked upstream despite generic
# artifact/log ignore rules, then normalize the Windows bind snapshot to the
# repository's Linux checkout policy.
git add --force --all
while IFS= read -r file; do
  sed -i 's/\r$//' "$file"
done < <(git grep -Il $'\r' -- .)
git add --all
git commit --quiet --message "CSW-127 Phase 0.6 proof snapshot"
git checkout-index --force --all
actual_tree=$(git rev-parse 'HEAD^{tree}')
printf '%s\n' "$actual_tree" >"${output_dir}/snapshot-tree.txt"
if test -n "$expected_tree" && test "$actual_tree" != "$expected_tree"; then
  echo "proof snapshot tree mismatch: expected=${expected_tree} actual=${actual_tree}" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq jq
fi

if test "$mode" = "broad"; then
  export CI=1
  mkdir -p "${HOME}/.local/bin"
  corepack enable --install-directory "${HOME}/.local/bin"
  export PATH="${HOME}/.local/bin:${PATH}"
  pnpm install --frozen-lockfile
  exec pnpm run check
fi

export CSW_127_PHASE0_6_PROOF_OUTPUT="$output_dir"
exec bash docs/proof/csw-127-phase0-6/run-proof.sh
