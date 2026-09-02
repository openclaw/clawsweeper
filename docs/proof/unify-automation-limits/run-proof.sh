#!/usr/bin/env bash
set -euo pipefail

artifact_dir="${UNIFY_AUTOMATION_LIMITS_PROOF_OUTPUT:-docs/proof/unify-automation-limits/artifacts}"
temp_dir="$(mktemp -d /tmp/unify-automation-limits-proof.XXXXXX)"

finish() {
  local proof_rc=$?
  rm -rf -- "$temp_dir"
  echo "PROOF_RC=$proof_rc"
}
trap finish EXIT

mkdir -p "$artifact_dir"
: >"$artifact_dir/value-equivalence.diff"

echo "== environment =="
echo "node=$(node --version)"
echo "head=$(git rev-parse HEAD)"

export PNPM_HOME="$HOME/.local/bin"
mkdir -p "$PNPM_HOME"
export PATH="$PNPM_HOME:$PATH"
if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable --install-directory "$PNPM_HOME" >/dev/null 2>&1 || true
fi
if ! command -v pnpm >/dev/null 2>&1; then
  npm install -g --prefix "$HOME/.local" pnpm@11.10.0 \
    >"$artifact_dir/pnpm-install.log" 2>&1
fi
echo "pnpm=$(pnpm --version)"

pnpm install --frozen-lockfile >"$artifact_dir/dependencies-install.log" 2>&1

echo "== select pre-change source =="
git fetch --no-tags origin main
if ! merge_base="$(git merge-base HEAD origin/main)"; then
  git fetch --no-tags --deepen=256 origin main
  merge_base="$(git merge-base HEAD origin/main)"
fi
origin_main_sha="$(git rev-parse origin/main)"

baseline_ref="origin/main"
baseline_reason="origin/main matches the merge-base limit modules and config"
if ! git diff --quiet "$merge_base" origin/main -- \
  src/limits.ts src/repair/limits.ts config/automation-limits.json; then
  baseline_ref="$merge_base"
  baseline_reason="origin/main changed the pre-change limit modules or config; pinned merge base"
fi
baseline_sha="$(git rev-parse "$baseline_ref")"

BASELINE_REF="$baseline_ref" \
BASELINE_SHA="$baseline_sha" \
BASELINE_REASON="$baseline_reason" \
MERGE_BASE_SHA="$merge_base" \
ORIGIN_MAIN_SHA="$origin_main_sha" \
node -e '
  const fs = require("node:fs");
  const value = {
    selected_ref: process.env.BASELINE_REF,
    selected_sha: process.env.BASELINE_SHA,
    reason: process.env.BASELINE_REASON,
    merge_base_sha: process.env.MERGE_BASE_SHA,
    origin_main_sha: process.env.ORIGIN_MAIN_SHA,
  };
  fs.writeFileSync(process.argv[1], JSON.stringify(value, null, 2) + "\n");
' "$artifact_dir/baseline.json"

echo "baseline_ref=$baseline_ref"
echo "baseline_sha=$baseline_sha"
echo "merge_base_sha=$merge_base"
echo "origin_main_sha=$origin_main_sha"

prepare_tree() {
  local tree_dir="$1"
  mkdir -p "$tree_dir/src/repair" "$tree_dir/config" "$tree_dir/dist"
  printf '%s\n' '{ "type": "module" }' >"$tree_dir/package.json"
}

old_root="$temp_dir/old-root"
old_repair="$temp_dir/old-repair"
current="$temp_dir/current"
prepare_tree "$old_root"
prepare_tree "$old_repair"
prepare_tree "$current"

git show "$baseline_ref:src/limits.ts" >"$old_root/src/limits.ts"
git show "$baseline_ref:src/queue-pressure.ts" >"$old_root/src/queue-pressure.ts"
git show "$baseline_ref:config/automation-limits.json" \
  >"$old_root/config/automation-limits.json"

git show "$baseline_ref:src/repair/limits.ts" >"$old_repair/src/repair/limits.ts"
git show "$baseline_ref:src/repair/paths.ts" >"$old_repair/src/repair/paths.ts"
git show "$baseline_ref:src/queue-pressure.ts" >"$old_repair/src/queue-pressure.ts"
git show "$baseline_ref:config/automation-limits.json" \
  >"$old_repair/config/automation-limits.json"

cp src/limits.ts "$current/src/limits.ts"
cp src/queue-pressure.ts "$current/src/queue-pressure.ts"
cp config/automation-limits.json "$current/config/automation-limits.json"

echo "== compile historical and canonical modules =="
{
  pnpm exec tsc --ignoreConfig --target es2024 --module nodenext \
    --moduleResolution nodenext --types node --strict --skipLibCheck \
    --rootDir "$old_root/src" --outDir "$old_root/dist" \
    "$old_root/src/limits.ts" "$old_root/src/queue-pressure.ts"
  pnpm exec tsc --ignoreConfig --target es2024 --module nodenext \
    --moduleResolution nodenext --types node --strict --skipLibCheck \
    --rootDir "$old_repair/src" --outDir "$old_repair/dist" \
    "$old_repair/src/repair/limits.ts" "$old_repair/src/repair/paths.ts" \
    "$old_repair/src/queue-pressure.ts"
  pnpm exec tsc --ignoreConfig --target es2024 --module nodenext \
    --moduleResolution nodenext --types node --strict --skipLibCheck \
    --rootDir "$current/src" --outDir "$current/dist" \
    "$current/src/limits.ts" "$current/src/queue-pressure.ts"
} >"$artifact_dir/compile.log" 2>&1

cat >"$temp_dir/dump-values.mjs" <<'EOF'
import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const [oldRootPath, oldRepairPath, currentPath, preOutput, currentOutput] = process.argv.slice(2);
const [oldRoot, oldRepair, current] = await Promise.all([
  import(pathToFileURL(oldRootPath)),
  import(pathToFileURL(oldRepairPath)),
  import(pathToFileURL(currentPath)),
]);

const rootLanes = [
  "normal_review",
  "hot_intake",
  "repair",
  "automerge_repair",
  "issue_implementation",
  "cluster_repair",
  "exact_item",
];
const unionLanes = [...rootLanes, "assist"];
const scenarios = {
  default: { activeCritical: 0, activeBackground: 0, pressureLevel: "none" },
  active_workers: { activeCritical: 7, activeBackground: 11, pressureLevel: "none" },
  soft_pressure: { activeCritical: 7, activeBackground: 11, pressureLevel: "soft" },
  hard_pressure: { activeCritical: 7, activeBackground: 11, pressureLevel: "hard" },
  unknown_pressure: { activeCritical: 7, activeBackground: 11, pressureLevel: "unknown" },
};
const workerMaxima = [64, 128, 256];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeEquivalent(left, right, path = "root") {
  if (!isRecord(left) || !isRecord(right)) {
    assert.deepEqual(left, right, `overlapping pre-change value differs at ${path}`);
    return structuredClone(left);
  }
  const result = structuredClone(left);
  for (const key of Object.keys(right)) {
    if (Object.hasOwn(result, key)) {
      result[key] = mergeEquivalent(result[key], right[key], `${path}.${key}`);
    } else {
      result[key] = structuredClone(right[key]);
    }
  }
  return result;
}

function withWorkerMax(config, max) {
  const value = structuredClone(config);
  value.workers.max = max;
  return value;
}

function oldUnionConfig(rootConfig, repairConfig) {
  return mergeEquivalent(rootConfig, repairConfig, "worker_config");
}

function oldUnionLimits(config) {
  return mergeEquivalent(
    oldRoot.deriveAutomationLimits(config),
    oldRepair.deriveAutomationLimits(config),
    "automation_limits",
  );
}

function oldUnionWorkerLimits(config, rootLimits, repairLimits, scenario) {
  const result = {};
  for (const lane of unionLanes) {
    const options = {
      ...scenario,
      config,
      limits: lane === "assist" ? repairLimits : rootLimits,
    };
    const repairValue = oldRepair.workerLimit(lane, {
      ...scenario,
      config,
      limits: repairLimits,
    });
    if (rootLanes.includes(lane)) {
      const rootValue = oldRoot.workerLimit(lane, options);
      assert.equal(rootValue, repairValue, `pre-change workerLimit drift for ${lane}`);
      result[lane] = rootValue;
    } else {
      result[lane] = repairValue;
    }
  }
  return result;
}

function currentWorkerLimits(config, limits, scenario) {
  return Object.fromEntries(
    unionLanes.map((lane) => [lane, current.workerLimit(lane, { ...scenario, config, limits })]),
  );
}

function buildPreChangeDump() {
  const constantConfig = oldUnionConfig(oldRoot.WORKER_CONFIG, oldRepair.WORKER_CONFIG);
  const readConfig = oldUnionConfig(oldRoot.readWorkerConfig(), oldRepair.readWorkerConfig());
  const output = {
    runtime_exports: {
      AUTOMATION_LIMITS: mergeEquivalent(
        oldRoot.AUTOMATION_LIMITS,
        oldRepair.AUTOMATION_LIMITS,
        "AUTOMATION_LIMITS",
      ),
      WORKER_CONFIG: constantConfig,
      readWorkerConfig: readConfig,
      deriveAutomationLimits: {},
      workerLimit: {},
    },
  };
  for (const max of workerMaxima) {
    const config = withWorkerMax(constantConfig, max);
    const rootLimits = oldRoot.deriveAutomationLimits(config);
    const repairLimits = oldRepair.deriveAutomationLimits(config);
    output.runtime_exports.deriveAutomationLimits[`workers_max_${max}`] =
      mergeEquivalent(rootLimits, repairLimits, `deriveAutomationLimits.${max}`);
    output.runtime_exports.workerLimit[`workers_max_${max}`] = Object.fromEntries(
      Object.entries(scenarios).map(([name, scenario]) => [
        name,
        oldUnionWorkerLimits(config, rootLimits, repairLimits, scenario),
      ]),
    );
  }
  return output;
}

function buildCurrentDump() {
  const output = {
    runtime_exports: {
      AUTOMATION_LIMITS: current.AUTOMATION_LIMITS,
      WORKER_CONFIG: current.WORKER_CONFIG,
      readWorkerConfig: current.readWorkerConfig(),
      deriveAutomationLimits: {},
      workerLimit: {},
    },
  };
  for (const max of workerMaxima) {
    const config = withWorkerMax(current.WORKER_CONFIG, max);
    const limits = current.deriveAutomationLimits(config);
    output.runtime_exports.deriveAutomationLimits[`workers_max_${max}`] = limits;
    output.runtime_exports.workerLimit[`workers_max_${max}`] = Object.fromEntries(
      Object.entries(scenarios).map(([name, scenario]) => [
        name,
        currentWorkerLimits(config, limits, scenario),
      ]),
    );
  }
  return output;
}

function sortRecursively(value) {
  if (Array.isArray(value)) return value.map(sortRecursively);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortRecursively(value[key])]),
  );
}

function writeCanonical(path, value) {
  fs.writeFileSync(path, JSON.stringify(sortRecursively(value), null, 2) + "\n");
}

writeCanonical(preOutput, buildPreChangeDump());
writeCanonical(currentOutput, buildCurrentDump());
EOF

echo "== dump canonical value surfaces =="
node "$temp_dir/dump-values.mjs" \
  "$old_root/dist/limits.js" \
  "$old_repair/dist/repair/limits.js" \
  "$current/dist/limits.js" \
  "$artifact_dir/pre-change-union.json" \
  "$artifact_dir/current-canonical.json"

echo "== compare pre-change union with current canonical module =="
diff -u \
  "$artifact_dir/pre-change-union.json" \
  "$artifact_dir/current-canonical.json" \
  >"$artifact_dir/value-equivalence.diff"
echo "value_diff=empty"

echo "== repository limit drift check =="
pnpm run check:limits 2>&1 | tee "$artifact_dir/check-limits.log"
