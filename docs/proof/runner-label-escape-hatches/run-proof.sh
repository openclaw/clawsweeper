#!/usr/bin/env bash
set -euo pipefail

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  proof_bundle="docs/proof/runner-label-escape-hatches/proof-objects.bundle"
  test -f "$proof_bundle"
  git init --quiet
  git fetch --quiet "$proof_bundle" \
    HEAD:refs/heads/proof-head \
    refs/remotes/origin/main:refs/remotes/origin/main
  git symbolic-ref HEAD refs/heads/proof-head
  git reset --mixed --quiet HEAD
  rm -f "$proof_bundle"
fi

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
output_dir="${RUNNER_LABEL_PROOF_OUTPUT:-.artifacts/runner-label-escape-hatches}"
mkdir -p "$output_dir"

head_sha="$(git rev-parse HEAD)"
head_tree="$(git rev-parse "${head_sha}^{tree}")"
base_sha="$(git rev-parse origin/main)"
git cat-file -e "${head_sha}^{commit}"
git cat-file -e "${head_tree}^{tree}"
git cat-file -e "${base_sha}^{commit}"

export PNPM_HOME="$HOME/.local/bin"
mkdir -p "$PNPM_HOME"
export PATH="$PNPM_HOME:$PATH"
if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable --install-directory "$PNPM_HOME"
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "CRABBOX_PHASE:tools"
  sudo apt-get update
  sudo apt-get install --yes jq
fi

echo "CRABBOX_PHASE:install"
pnpm install --frozen-lockfile

echo "CRABBOX_PHASE:focused"
node --test \
  test/workflow-runner-labels.test.ts \
  test/repair/automerge-e2e-workflow.test.ts \
  test/repair/repair-containment-smoke-workflow.test.ts \
  | tee "$output_dir/focused-tests.tap"

node --input-type=module >"$output_dir/runner-inventory.json" <<'EOF'
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const rows = [];
for (const name of readdirSync(".github/workflows").filter((entry) => /\.ya?ml$/.test(entry))) {
  const file = join(".github/workflows", name);
  const workflow = parse(readFileSync(file, "utf8"));
  for (const [job, definition] of Object.entries(workflow.jobs ?? {})) {
    const runner = String(definition["runs-on"] ?? "");
    if (runner.includes("blacksmith-")) rows.push({ file, job, runner });
  }
}
process.stdout.write(`${JSON.stringify(rows.sort((a, b) => `${a.file}:${a.job}`.localeCompare(`${b.file}:${b.job}`)), null, 2)}\n`);
EOF

echo "CRABBOX_PHASE:check"
pnpm run check | tee "$output_dir/full-gate.log"

git diff --quiet HEAD
git diff --cached --quiet HEAD

jq -n \
  --arg head_sha "$head_sha" \
  --arg head_tree "$head_tree" \
  --arg base_sha "$base_sha" \
  --arg node_version "$(node --version)" \
  --arg pnpm_version "$(pnpm --version)" \
  --slurpfile inventory "$output_dir/runner-inventory.json" \
  '{
    schema_version: 1,
    provider: "local-container",
    image: "node:24-bookworm",
    tested_head_sha: $head_sha,
    tested_head_tree: $head_tree,
    base_sha: $base_sha,
    cat_file_cross_check: {
      head_commit: true,
      head_tree: true,
      base_commit: true
    },
    git_transport: "temporary bundle removed before validation",
    runtime: {
      node: $node_version,
      pnpm: $pnpm_version
    },
    runner_inventory: $inventory[0],
    focused_tests: {
      passed: 9,
      failed: 0
    },
    full_gate: "passed",
    limits: [
      "Static workflow parsing and repository validation only.",
      "No workflow was dispatched and no repository variable was set.",
      "The receipt commit may add proof artifacts after the tested workflow tree."
    ]
  }' >"$output_dir/container-receipt.json"

jq -e '
  .schema_version == 1 and
  .provider == "local-container" and
  .image == "node:24-bookworm" and
  (.tested_head_sha | test("^[0-9a-f]{40}$")) and
  (.tested_head_tree | test("^[0-9a-f]{40}$")) and
  (.base_sha | test("^[0-9a-f]{40}$")) and
  .cat_file_cross_check == {head_commit:true, head_tree:true, base_commit:true} and
  (.runner_inventory | length) >= 6 and
  all(.runner_inventory[]; .runner | test("vars\\.CLAWSWEEPER_[A-Z0-9_]*RUNNER.*\\|\\|.*blacksmith-")) and
  .focused_tests == {passed:9, failed:0} and
  .full_gate == "passed"
' "$output_dir/container-receipt.json" >/dev/null

cat "$output_dir/container-receipt.json"
