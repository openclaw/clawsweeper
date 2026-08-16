#!/usr/bin/env bash
set -euo pipefail

expected_head="${1:?expected source head is required}"
base_head="${2:?merge-base head is required}"
proof_pattern='operational health excludes wedged|pre-queue rerun cancellation conflict exits successfully|aged pending rerun exits successfully|public status projection retains wedged|dashboard surfaces stale queue ghosts|dashboard hero treats apply'
source_files=(
  dashboard/operational-health.ts
  scripts/stuck-queued-run-remediation.mjs
)
scratch_dir="$(mktemp -d)"
bundle_checkout=""

cleanup() {
  for source_file in "${source_files[@]}"; do
    git show "${expected_head}:${source_file}" >"${source_file}"
  done
  rm -rf "${scratch_dir}"
  if [[ -n "${bundle_checkout}" ]]; then
    rm -rf "${bundle_checkout}"
  fi
}
trap cleanup EXIT

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  bundle_path="${PWD}/.crabbox-source.bundle"
  test -f "${bundle_path}"
  bundle_checkout="$(mktemp -d)"
  rmdir "${bundle_checkout}"
  git clone --quiet "${bundle_path}" "${bundle_checkout}"
  cd "${bundle_checkout}"
fi

export PNPM_HOME="${HOME}/.local/bin"
export PATH="${PNPM_HOME}:${PATH}"
mkdir -p "${PNPM_HOME}"

printf 'Wedged rerun classification Docker-backed proof\n'
printf 'provider=local-container\n'
printf 'image=node:24-bookworm\n'
printf 'checkout_head=%s\n' "$(git rev-parse HEAD)"
printf 'expected_head=%s\n' "${expected_head}"
printf 'base_head=%s\n' "${base_head}"
printf 'node=%s\n' "$(node --version)"

test "$(git rev-parse HEAD)" = "${expected_head}"
git cat-file -e "${expected_head}^{commit}"
git cat-file -e "${base_head}^{commit}"
test "$(git merge-base "${expected_head}" "${base_head}")" = "${base_head}"
printf 'commit_object_cross_check=pass\n'

corepack enable --install-directory "${PNPM_HOME}"
corepack install --global pnpm@11.10.0
if ! command -v jq >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq jq
fi
printf 'pnpm=%s\n' "$(pnpm --version)"
printf 'jq=%s\n' "$(jq --version)"
printf 'docker=%s\n' "$(docker --version 2>/dev/null || printf 'host-backed local-container')"

printf '\nCRABBOX_PHASE:install\n'
pnpm install --frozen-lockfile

printf '\nCRABBOX_PHASE:red\n'
for source_file in "${source_files[@]}"; do
  git show "${base_head}:${source_file}" >"${source_file}"
done
set +e
node --test \
  --test-name-pattern='operational health excludes wedged|pre-queue rerun cancellation conflict exits successfully|aged pending rerun exits successfully' \
  test/dashboard-operational-health.test.ts \
  test/stuck-queued-run-remediation.test.ts \
  >"${scratch_dir}/red.log" 2>&1
red_exit=$?
set -e
sed -n '/operational health excludes wedged/,/duration_ms/p' "${scratch_dir}/red.log"
printf 'red_test_exit=%s\n' "${red_exit}"
test "${red_exit}" -eq 1
grep -Fq "'degraded'" "${scratch_dir}/red.log"
grep -Fq 'wedged_rerun' "${scratch_dir}/red.log"

for source_file in "${source_files[@]}"; do
  git show "${expected_head}:${source_file}" >"${source_file}"
  test "$(git hash-object "${source_file}")" = "$(git rev-parse "${expected_head}:${source_file}")"
done
printf 'production_sources_restored=true\n'

printf '\nCRABBOX_PHASE:green\n'
pnpm run build:all
node --test \
  --test-name-pattern="${proof_pattern}" \
  test/dashboard-operational-health.test.ts \
  test/stuck-queued-run-remediation.test.ts \
  test/dashboard-worker-status-privacy.test.ts \
  test/dashboard-worker-dashboard-status.test.ts \
  >"${scratch_dir}/green.log" 2>&1
sed -n '1,240p' "${scratch_dir}/green.log"
grep -Fq 'ℹ pass 6' "${scratch_dir}/green.log"
grep -Fq 'ℹ fail 0' "${scratch_dir}/green.log"
printf 'green_test_exit=0\n'

printf '\nCRABBOX_PHASE:dashboard-strict\n'
pnpm run check:dashboard-strict
printf 'dashboard_strict=pass\n'

printf '\nCRABBOX_PHASE:full-gate\n'
pnpm run check
printf 'full_gate=pass\n'
printf 'PROOF_EXIT=0\n'
