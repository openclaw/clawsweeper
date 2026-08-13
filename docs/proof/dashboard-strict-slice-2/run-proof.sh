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

corepack enable
pnpm install --frozen-lockfile
pnpm run check:dashboard-strict
node --test test/check-dashboard-strict.test.ts
pnpm run check
node docs/proof/dashboard-strict-slice-2/run-proof.mjs
