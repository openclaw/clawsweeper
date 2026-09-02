#!/usr/bin/env bash
set -euo pipefail

proof_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "$proof_dir" rev-parse --show-toplevel)"
artifact_dir="${STATUS_CHECK_ROLLUP_PROOF_OUTPUT:-$proof_dir/artifacts}"
temp_dir="$(mktemp -d /tmp/status-check-rollup-proof.XXXXXX)"
old_commit="e13791786799f6a51a39806938847bbc48948e5e"
subject_pr="1099"
subject_prefix="codex/disk-full-incident"
generated_report_json="$repo_root/results/finalize-open-prs.json"
generated_report_md="$repo_root/results/finalize-open-prs.md"

cleanup() {
  local proof_rc=$?
  rm -rf -- "$temp_dir"
  rm -f -- "$generated_report_json" "$generated_report_md"
  echo "PROOF_RC=$proof_rc"
}
trap cleanup EXIT

cd "$repo_root"
for command_name in gh git node pnpm; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "required command not found: $command_name" >&2
    exit 1
  }
done
if test -e "$generated_report_json" || test -e "$generated_report_md"; then
  echo "refusing to overwrite an existing finalizer report" >&2
  exit 1
fi

mkdir -p "$artifact_dir" "$temp_dir/current/src/repair" "$temp_dir/current/dist"
proof_head="$(git rev-parse HEAD)"

echo "== environment =="
echo "node=$(node --version)"
echo "pnpm=$(pnpm --version)"
echo "gh=$(gh --version | head -n 1)"
echo "head=$proof_head"

echo "== dependencies and current module =="
pnpm install --frozen-lockfile >"$artifact_dir/dependencies-install.log" 2>&1
cp src/repair/status-check-rollup.ts "$temp_dir/current/src/repair/status-check-rollup.ts"
cp src/repair/json-types.ts "$temp_dir/current/src/repair/json-types.ts"
printf '%s\n' '{ "type": "module" }' >"$temp_dir/current/package.json"
pnpm exec tsc --ignoreConfig --target es2024 --module nodenext \
  --moduleResolution nodenext --types node --strict --skipLibCheck \
  --rootDir "$temp_dir/current/src" --outDir "$temp_dir/current/dist" \
  "$temp_dir/current/src/repair/status-check-rollup.ts" \
  "$temp_dir/current/src/repair/json-types.ts" \
  >"$artifact_dir/compile-current.log" 2>&1

echo "== acquire real GitHub payload =="
gh pr view "$subject_pr" --repo openclaw/clawsweeper \
  --json number,url,headRefOid,statusCheckRollup >"$temp_dir/subject.json"

echo "== reconstruct historical classifier =="
git show "$old_commit:src/repair/finalize-open-prs.ts" \
  >"$temp_dir/historical-finalize-open-prs.ts"

echo "== classify identical payload before and after =="
PROOF_HEAD="$proof_head" node "$proof_dir/classify-checks.mjs" \
  "$temp_dir/subject.json" \
  "$temp_dir/historical-finalize-open-prs.ts" \
  "$temp_dir/current/dist/repair/status-check-rollup.js" \
  "$artifact_dir"

echo "== production report-only finalizer =="
pnpm run build:repair >"$artifact_dir/build-repair.log" 2>&1
node dist/repair/finalize-open-prs.js \
  --repo openclaw/clawsweeper \
  --head-prefix "$subject_prefix" \
  --write-report >"$temp_dir/report-only-finalizer.json"
node - "$temp_dir/report-only-finalizer.json" "$artifact_dir/report-only-finalizer.txt" <<'EOF'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const pull = report.prs.find((item) => item.number === 1099);
assert(pull, "report-only finalizer did not include PR #1099");
assert.deepEqual(pull.checks.blockers, [], "report-only finalizer retained a check blocker");
assert(!pull.blockers.some((item) => item.startsWith("needs_checks")));
const lines = [
  `dispatch.enabled=${report.dispatch.enabled}`,
  `dispatch.execute=${report.dispatch.execute}`,
  `dispatch.candidates=${JSON.stringify(report.dispatch.candidates)}`,
  `summary.needs_checks=${report.summary.needs_checks}`,
  `pr=${pull.number}`,
  `checks.total=${pull.checks.total}`,
  `checks.counts=${JSON.stringify(pull.checks.counts)}`,
  `checks.blockers=${JSON.stringify(pull.checks.blockers)}`,
  `needs_checks=${pull.blockers.find((item) => item.startsWith("needs_checks")) ?? null}`,
];
fs.writeFileSync(process.argv[3], `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
EOF

echo "proof_result=passed"
