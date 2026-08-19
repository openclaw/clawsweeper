#!/usr/bin/env bash
set -euo pipefail

expected_head="${1:?expected PR head is required}"
base_head="${2:?merge-base head is required}"
proof_pattern='discovery GitHub throttling|persistent discovery 5xx|non-throttle discovery 403|unexpected discovery response shape|mid-remediation throttling|queued workflow remediation'
remediation_script="scripts/stuck-queued-run-remediation.mjs"
scratch_dir="$(mktemp -d)"

cleanup() {
  git show "${expected_head}:${remediation_script}" >"${remediation_script}"
  rm -rf "${scratch_dir}"
}
trap cleanup EXIT

export PNPM_HOME="${HOME}/.local/bin"
export PATH="${PNPM_HOME}:${PATH}"
mkdir -p "${PNPM_HOME}"

printf 'Remediation throttle skip Docker-backed proof\n'
printf 'provider=local-container\n'
printf 'image=node:24-bookworm\n'
printf 'checkout_head=%s\n' "$(git rev-parse HEAD)"
printf 'expected_head=%s\n' "${expected_head}"
printf 'base_head=%s\n' "${base_head}"
printf 'node=%s\n' "$(node --version)"

test "$(git rev-parse HEAD)" = "${expected_head}"
git fetch --quiet --no-tags origin main
git cat-file -e "${base_head}^{commit}"

corepack enable --install-directory "${PNPM_HOME}"
corepack install --global pnpm@11.10.0
printf 'pnpm=%s\n' "$(pnpm --version)"
printf 'docker=%s\n' "$(docker --version 2>/dev/null || printf 'host-backed local-container')"

printf '\nCRABBOX_PHASE:install\n'
pnpm install --frozen-lockfile

printf '\nCRABBOX_PHASE:red\n'
printf 'RED: PR test fixture against merge-base production script\n'
printf 'command=node --test --test-name-pattern=discovery_GitHub_throttling test/stuck-queued-run-remediation.test.ts\n'
git show "${base_head}:${remediation_script}" >"${remediation_script}"
set +e
node --test \
  --test-name-pattern='discovery GitHub throttling' \
  test/stuck-queued-run-remediation.test.ts \
  >"${scratch_dir}/red.log" 2>&1
red_exit=$?
set -e
sed -n '/discovery GitHub throttling exits successfully/,/duration_ms/p' "${scratch_dir}/red.log"
printf 'red_test_exit=%s\n' "${red_exit}"
printf 'old_production_child_exit=1 (reported by the failed assertion above)\n'
test "${red_exit}" -eq 1
grep -Fq '1 !== 0' "${scratch_dir}/red.log"
grep -Fq 'returned 403' "${scratch_dir}/red.log"

printf '\nCRABBOX_PHASE:green\n'
printf 'GREEN: PR implementation plus workflow isolation\n'
printf 'command=node --test --test-name-pattern=%s test/stuck-queued-run-remediation.test.ts test/review-reliability-workflow.test.ts\n' "${proof_pattern}"
git show "${expected_head}:${remediation_script}" >"${remediation_script}"
node --test \
  --test-name-pattern="${proof_pattern}" \
  test/stuck-queued-run-remediation.test.ts \
  test/review-reliability-workflow.test.ts \
  >"${scratch_dir}/green.log" 2>&1
sed -n '1,240p' "${scratch_dir}/green.log"
printf 'green_test_exit=0\n'
printf 'new_production_throttled_child_exit=0 (asserted by passing scenario)\n'
printf 'asserted_skip_line=%s\n' '{"event":"stuck_queued_remediation_skipped","skip_reasons":{"github_throttled":1},"phase":"discovery","request_path":"/actions/runs?status=queued&per_page=100&page=1"}'
printf 'persistent_5xx_child_exit=1 (asserted after three bounded attempts)\n'
printf 'workflow_shape=pass (remediation isolated; both reconcile stages precede deferred failure; absent artifacts ignored)\n'

test "$(grep -c '^✔ ' "${scratch_dir}/green.log")" -eq 6
grep -Fq 'ℹ tests 6' "${scratch_dir}/green.log"
grep -Fq 'ℹ pass 6' "${scratch_dir}/green.log"
grep -Fq 'ℹ fail 0' "${scratch_dir}/green.log"
test "$(git hash-object "${remediation_script}")" = "$(git rev-parse "${expected_head}:${remediation_script}")"
printf 'production_script_restored=true\n'
printf 'PROOF_EXIT=0\n'
