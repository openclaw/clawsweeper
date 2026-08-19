#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
output_dir="${ROUTER_THROTTLE_PROOF_OUTPUT:-.artifacts/router-throttle-resilience}"
mkdir -p "$output_dir"

head_sha="$(git rev-parse HEAD)"
head_tree="$(git rev-parse "${head_sha}^{tree}")"
base_sha="$(git rev-parse origin/main)"
git cat-file -e "${head_sha}^{commit}"
git cat-file -e "${head_tree}^{tree}"
git cat-file -e "${base_sha}^{commit}"

node scripts/e2e/comment-router-throttle-loopback.mjs > "$output_dir/behavior-result.json"
jq -e '
  .ok == true and
  .transport == "loopback HTTP via GITHUB_API_URL" and
  (.assertions | all(.[]; . == true)) and
  any(.requests[]; contains("issues/comments?since=") and contains("sort=updated") and contains("direction=asc"))
' "$output_dir/behavior-result.json" >/dev/null

node --test \
  test/repair/comment-router-throttle-resilience.test.ts \
  test/repair/comment-router-action-ledger.test.ts \
  test/repair/github-cli.test.ts \
  > "$output_dir/focused-tests.tap"

jq -n \
  --arg head_sha "$head_sha" \
  --arg head_tree "$head_tree" \
  --arg base_sha "$base_sha" \
  --arg node_version "$(node --version)" \
  --arg pnpm_version "$(pnpm --version)" \
  --slurpfile behavior "$output_dir/behavior-result.json" \
  '{
    schema_version: 1,
    head_sha: $head_sha,
    head_tree: $head_tree,
    base_sha: $base_sha,
    cat_file_cross_check: {
      head_commit: true,
      head_tree: true,
      base_commit: true
    },
    runtime: {
      node: $node_version,
      pnpm: $pnpm_version,
      transport: $behavior[0].transport
    },
    assertions: $behavior[0].assertions,
    request_count: ($behavior[0].requests | length),
    focused_tests_tap: "focused-tests.tap",
    limits: "Loopback GitHub API with synthetic credentials; no live GitHub mutation or production workflow dispatch."
  }' > "$output_dir/container-receipt.json"

jq -e '
  .schema_version == 1 and
  (.head_sha | test("^[0-9a-f]{40}$")) and
  (.head_tree | test("^[0-9a-f]{40}$")) and
  (.base_sha | test("^[0-9a-f]{40}$")) and
  .cat_file_cross_check == {head_commit:true, head_tree:true, base_commit:true} and
  (.assertions | all(.[]; . == true))
' "$output_dir/container-receipt.json" >/dev/null

cat "$output_dir/container-receipt.json"
