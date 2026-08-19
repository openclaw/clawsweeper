#!/usr/bin/env bash
set -euo pipefail

expected_head="${1:?expected head is required}"
expected_base="${2:?expected merge base is required}"
output_dir="${AUTOMERGE_QUOTA_PROOF_OUTPUT:-.artifacts/fix-automerge-quota-fixture}"

actual_head="$(git rev-parse HEAD)"
head_tree="$(git rev-parse "${actual_head}^{tree}")"
merge_base="$(git merge-base HEAD origin/main)"

test "$actual_head" = "$expected_head"
test "$merge_base" = "$expected_base"
git cat-file -e "${actual_head}^{commit}"
git cat-file -e "${head_tree}^{tree}"
git cat-file -e "${merge_base}^{commit}"

echo CRABBOX_PHASE:install
corepack prepare pnpm@11.10.0 --activate
pnpm install --frozen-lockfile

echo CRABBOX_PHASE:build
pnpm run build:node

echo CRABBOX_PHASE:quota_fixture
mkdir -p "$output_dir"
node scripts/e2e/automerge.mjs \
  --scenario github-api-quota-fail-fast \
  --fixture tiny \
  --output "$output_dir/automerge"

summary="$output_dir/automerge/tiny/github-api-quota-fail-fast/summary.json"
jq -e '
  .status == "passed" and
  .fixture == "tiny" and
  .scenario == "github-api-quota-fail-fast" and
  .container == true and
  .transport == "actual gh HTTP over an owned Unix socket" and
  [.results[].http_status] == [403, 429] and
  (.results | all(
    .requests == 1 and
    .request.method == "GET" and
    (.request.path | endswith("/repos/openclaw/openclaw/issues/42")) and
    .request.authenticated == true and
    .publisher_exit == 1 and
    .completion_kind == "retryable_failure" and
    .failure_kind == "github_rate_limit" and
    .batch_kind == "retryable_failure" and
    .cleanup_deletes == 0
  ))
' "$summary" >/dev/null

echo CRABBOX_PHASE:full_gate
pnpm run check

echo CRABBOX_PHASE:receipt
jq -n \
  --arg head_sha "$actual_head" \
  --arg head_tree "$head_tree" \
  --arg base_sha "$merge_base" \
  --arg node_version "$(node --version)" \
  --arg pnpm_version "$(pnpm --version)" \
  --slurpfile result "$summary" \
  '{
    schema_version: 1,
    tested_head_sha: $head_sha,
    tested_head_tree: $head_tree,
    base_sha: $base_sha,
    cat_file_cross_check: {
      head_commit: true,
      head_tree: true,
      base_commit: true
    },
    runtime: {
      node: $node_version,
      pnpm: $pnpm_version,
      transport: $result[0].transport
    },
    quota_fixture: {
      statuses: [$result[0].results[].http_status],
      requests: [$result[0].results[].requests],
      publisher_exits: [$result[0].results[].publisher_exit],
      completion_kinds: [$result[0].results[].completion_kind],
      failure_kinds: [$result[0].results[].failure_kind],
      batch_kinds: [$result[0].results[].batch_kind],
      cleanup_deletes: [$result[0].results[].cleanup_deletes]
    },
    full_gate: {
      command: "pnpm run check",
      exit_code: 0
    },
    limits: [
      "The GitHub API was a deterministic Unix-socket loopback fixture with synthetic credentials.",
      "No production GitHub, Worker, queue, deployment, or workflow state was mutated.",
      "The receipt commit adds proof metadata only after the tested runtime tree."
    ]
  }' > "$output_dir/container-receipt.json"

jq -e '
  .schema_version == 1 and
  (.tested_head_sha | test("^[0-9a-f]{40}$")) and
  (.tested_head_tree | test("^[0-9a-f]{40}$")) and
  (.base_sha | test("^[0-9a-f]{40}$")) and
  .cat_file_cross_check == {head_commit:true, head_tree:true, base_commit:true} and
  .quota_fixture.statuses == [403, 429] and
  .quota_fixture.requests == [1, 1] and
  .quota_fixture.publisher_exits == [1, 1] and
  .quota_fixture.completion_kinds == ["retryable_failure", "retryable_failure"] and
  .quota_fixture.failure_kinds == ["github_rate_limit", "github_rate_limit"] and
  .quota_fixture.batch_kinds == ["retryable_failure", "retryable_failure"] and
  .quota_fixture.cleanup_deletes == [0, 0] and
  .full_gate.exit_code == 0
' "$output_dir/container-receipt.json" >/dev/null

cat "$output_dir/container-receipt.json"
echo "AUTOMERGE_QUOTA_FIXTURE_PROOF_OK head=$actual_head base=$merge_base"
