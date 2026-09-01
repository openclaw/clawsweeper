#!/usr/bin/env bash
set -euo pipefail

echo "CRABBOX_PHASE:install"
corepack_bin="$HOME/.local/bin"
mkdir -p "$corepack_bin"
corepack enable --install-directory "$corepack_bin"
export PATH="$corepack_bin:$PATH"
pnpm install --frozen-lockfile

echo "CRABBOX_PHASE:build"
pnpm run build:all

echo "CRABBOX_PHASE:contract"
node --test --test-name-pattern='exact event review publishes directly|scheduled review shards retire automatic live proof' test/sweep-workflow.test.ts
node --test --test-name-pattern='review prompt and generation schema constrain live proof|automatic live proof is retired|historical proof-bearing exact review bundles|new exact review bundle creation omits|review jobs upload completed reviews|historical publication lanes preserve' test/review-prompt-policy.test.ts test/live-proof.test.ts test/repair/exact-review-bundle.test.ts test/repair/workflow-sparse-checkout.test.ts
node --test --test-name-pattern='excludes the retired batch path|retains direct-path classification|tide rebuild preserves pre-change direct|refreshes a retained terminal outcome|keeps failed legacy publishers|migration recovers retained pre-v2 direct tide rows|repairs failed publishers after path migration and timing expiry|migration keeps every retained pre-v2 batch router variant legacy|samples normal direct work before hidden legacy rows|preserves a direct review beside newer legacy publication work|keeps opposite-path direct queue work beside an active legacy worker|retains simultaneous direct and legacy workers for one target|public, indexable, hardened canonical route|reprojects status into a closed aggregate client model|classifies scheduled batches without hiding direct recovery|keeps scheduled exact reviews on the direct path|retains the legacy path during batch terminal finalization|refreshes a durable snapshot that predates the legacy timing aggregate' test/dashboard-worker-bay-records-routes.test.ts test/dashboard-worker-status-privacy.test.ts test/dashboard-worker-observability.test.ts
node --test --test-name-pattern='direct publication endpoint authenticates|batch claims retain lifecycle identity' test/dashboard-worker-publication-lifecycle.test.ts test/exact-review-publication-batches.test.ts

echo "CRABBOX_PHASE:runtime"
runtime_dir=$(mktemp -d "${TMPDIR:-/tmp}/retire-live-proof-runtime.XXXXXX")
runtime_log="$runtime_dir/wrangler.log"
runtime_port=8797
runtime_pid=""
cleanup_runtime() {
  if [ -n "$runtime_pid" ]; then
    kill -TERM -- "-$runtime_pid" >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do
      if ! kill -0 "$runtime_pid" >/dev/null 2>&1; then
        break
      fi
      sleep 0.25
    done
    kill -KILL -- "-$runtime_pid" >/dev/null 2>&1 || true
    wait "$runtime_pid" >/dev/null 2>&1 || true
  fi
  rm -rf "$runtime_dir"
}
trap cleanup_runtime EXIT
mkdir -p "$runtime_dir/tmp"
setsid env TMPDIR="$runtime_dir/tmp" scripts/live-proof/bay-demo/start.sh "$runtime_port" >"$runtime_log" 2>&1 &
runtime_pid=$!
for _ in $(seq 1 180); do
  if grep -q 'OpenClaw Bay demo ready:' "$runtime_log"; then
    break
  fi
  if ! kill -0 "$runtime_pid" >/dev/null 2>&1; then
    tail -n 100 "$runtime_log" >&2
    exit 1
  fi
  sleep 1
done
grep -q 'OpenClaw Bay demo ready:' "$runtime_log"
node docs/proof/retire-automatic-live-proof/runtime-proof.mjs "http://127.0.0.1:$runtime_port"
cleanup_runtime
runtime_pid=""
trap - EXIT

! grep -q 'live-proof-review' .github/workflows/sweep.yml
! grep -q 'EXACT_REVIEW_LIVE_PROOF_DIR' .github/workflows/sweep.yml
! grep -q 'execute-exact-live-proof' .github/workflows/sweep.yml
test ! -e scripts/e2e/terminal-proof-planning.mjs
test ! -e docs/proof/terminal-proof-planning

grep -q 'Fold exact live proof into the review artifact' .github/workflows/sweep.yml
grep -q 'Fold live proofs into review artifacts' .github/workflows/sweep.yml
grep -q 'Include retired proof/batch' dashboard/bay-page.ts

echo 'PROOF_RESULT=automatic-live-proof-retired'
echo 'PROOF_COMPATIBILITY=historical-publication-retained'
echo 'PROOF_BAY_DEFAULT=normal-direct-reviews'
