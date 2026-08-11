#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
base_ref="${1:-origin/main}"
proof_root="$repo_root/docs/proof/modernize-stdlib-batch"
artifact_root="$proof_root/artifacts"
fixture_root="$(mktemp -d /tmp/clawsweeper-modernize-proof.XXXXXX)"
trap 'rm -rf "$fixture_root"' EXIT

mkdir -p "$artifact_root" "$fixture_root/scripts/e2e"
git show "$base_ref:scripts/e2e/automerge.mjs" >"$fixture_root/scripts/e2e/automerge.mjs"
ln -s "$repo_root/test" "$fixture_root/test"

parser_files=(
  src/repair/action-ledger-cli.ts
  src/repair/publish-main.ts
  src/repair/collect-codex-debug.ts
  scripts/exact-review-dead-letter-operator.mjs
  scripts/hydrate-state.ts
  scripts/e2e/automerge.mjs
  scripts/e2e/automerge-container.mjs
)

check_base_adoption() {
  local failed=0
  local file
  for file in "${parser_files[@]}"; do
    if git show "$base_ref:$file" | rg -q 'parseArgs as parseNodeArgs'; then
      printf 'adopted %s\n' "$file"
    else
      printf 'missing %s\n' "$file"
      failed=1
    fi
  done
  return "$failed"
}

check_current_adoption() {
  local file
  for file in "${parser_files[@]}"; do
    rg -q 'parseArgs as parseNodeArgs' "$repo_root/$file"
    printf 'adopted %s\n' "$file"
  done
}

set +e
check_base_adoption >"$artifact_root/adoption-red.log" 2>&1
red_rc=$?
set -e
test "$red_rc" -ne 0
check_current_adoption >"$artifact_root/adoption-green.log" 2>&1

run_case() {
  local entry="$1"
  local output="$2"
  local name="$3"
  shift 3
  local stdout_file="$fixture_root/stdout"
  local stderr_file="$fixture_root/stderr"
  local rc

  set +e
  node "$entry" "$@" >"$stdout_file" 2>"$stderr_file"
  rc=$?
  set -e

  {
    printf 'case=%s\n' "$name"
    printf 'argv='
    printf ' %q' "$@"
    printf '\nexit=%s\n' "$rc"
    printf 'stdout<<EOF\n'
    cat "$stdout_file"
    printf 'EOF\n'
    printf 'stderr_contract<<EOF\n'
    sed -n '/Error: / { s/^.*Error: /Error: /; p; q; }' "$stderr_file"
    printf 'EOF\n'
  } >>"$output"
}

run_matrix() {
  local entry="$1"
  local output="$2"
  : >"$output"
  run_case "$entry" "$output" help --help
  run_case "$entry" "$output" separator-help -- --help
  run_case "$entry" "$output" repeated-help --scenario first --scenario second --help
  run_case "$entry" "$output" unknown --unknown
  run_case "$entry" "$output" missing-value --scenario
}

before="$artifact_root/cli-before.txt"
after="$artifact_root/cli-after.txt"
run_matrix "$fixture_root/scripts/e2e/automerge.mjs" "$before"
run_matrix "$repo_root/scripts/e2e/automerge.mjs" "$after"
diff -u "$before" "$after" >"$artifact_root/cli-transcript.diff"

printf 'base_ref=%s\n' "$base_ref"
printf 'base_sha=%s\n' "$(git rev-parse "$base_ref")"
printf 'head_sha=%s\n' "$(git rev-parse HEAD)"
printf 'red_rc=%s\n' "$red_rc"
printf 'green_rc=0\n'
printf 'cli_diff=empty\n'
