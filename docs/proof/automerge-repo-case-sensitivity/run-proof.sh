#!/usr/bin/env bash
# Crabbox local-container proof for the repository-slug case-sensitivity fix.
#
# Runs inside a Node 24 Linux container on the synced current checkout. It builds
# the repair lane, compiles the PRE-FIX repair modules from the merge base so the
# before/after contrast is measured rather than asserted, then runs run-proof.mjs
# and the focused suites.
set -euo pipefail

ARTIFACT_DIR=".artifacts/automerge-repo-case-proof"
mkdir -p "$ARTIFACT_DIR"
BASE_REF="${REPO_CASE_PROOF_BASE:-0588bda9}"

echo "== environment =="
uname -a
node --version
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "FAIL: repository requires Node >= 24, got $(node --version)"
  exit 1
fi
echo "head: $(git rev-parse HEAD 2>/dev/null || echo 'unavailable')"
echo "base: $BASE_REF"
echo

echo "== build =="
# The lease runs as the unprivileged `crabbox` user, so corepack cannot symlink
# into /usr/local/bin. Install the pinned pnpm into a user-writable prefix.
export PNPM_HOME="$HOME/.local/bin"
mkdir -p "$PNPM_HOME"
export PATH="$PNPM_HOME:$PATH"
if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable --install-directory "$PNPM_HOME" >/dev/null 2>&1 || true
fi
if ! command -v pnpm >/dev/null 2>&1; then
  npm install -g --prefix "$HOME/.local" pnpm@11.10.0 >"$ARTIFACT_DIR/pnpm-install.log" 2>&1 || true
fi
command -v pnpm >/dev/null 2>&1 || {
  echo "FAIL: pnpm unavailable in container"
  tail -20 "$ARTIFACT_DIR/pnpm-install.log" 2>/dev/null || true
  exit 1
}
echo "pnpm: $(pnpm --version)"
pnpm install --frozen-lockfile >"$ARTIFACT_DIR/install.log" 2>&1 \
  || { echo "FAIL: pnpm install"; tail -30 "$ARTIFACT_DIR/install.log"; exit 1; }
# build:node, not build:repair: test/helpers.ts (used by post-flight.test.ts)
# imports dist/clawsweeper.js and dist/review-activity-cursor.js from the MAIN
# build, so the repair lane alone leaves the focused suites unable to load.
pnpm run build:node >"$ARTIFACT_DIR/build.log" 2>&1 \
  || { echo "FAIL: pnpm run build:node"; tail -30 "$ARTIFACT_DIR/build.log"; exit 1; }
test -f dist/repair/automerge-outcome.js || { echo "FAIL: repair build artifact missing"; exit 1; }
test -f dist/clawsweeper.js || { echo "FAIL: main build artifact missing"; exit 1; }
echo "post-fix comparator: $(grep -c 'sameRepoSlug' dist/repair/automerge-outcome.js || true) sameRepoSlug references (expect >0)"
echo

echo "== compile pre-fix modules from $BASE_REF =="
# automerge-outcome.ts's runtime import closure is just github-ref.ts (json-types
# is type-only and erases), so the two files compile standalone. That is far more
# robust inside a lease than reconstructing the whole repair lane.
PREFIX_DIR="$(mktemp -d)"
mkdir -p "$PREFIX_DIR/src"
git show "$BASE_REF:src/repair/automerge-outcome.ts" > "$PREFIX_DIR/src/automerge-outcome.ts"
git show "$BASE_REF:src/repair/github-ref.ts" > "$PREFIX_DIR/src/github-ref.ts"
git show "$BASE_REF:src/repair/json-types.ts" > "$PREFIX_DIR/src/json-types.ts"
./node_modules/.bin/tsc "$PREFIX_DIR/src/automerge-outcome.ts" --ignoreConfig \
  --target es2022 --module esnext --moduleResolution bundler --outDir "$PREFIX_DIR/out" \
  >"$ARTIFACT_DIR/prefix-build.log" 2>&1 || true
PREFIX_REPAIR="$PREFIX_DIR/out"
if [ ! -f "$PREFIX_REPAIR/automerge-outcome.js" ]; then
  PREFIX_REPAIR=""
  echo "pre-fix build: unavailable (before/after contrast reports SKIPPED and FAILS)"
  tail -20 "$ARTIFACT_DIR/prefix-build.log" 2>/dev/null || true
else
  echo "pre-fix comparator: $(grep -c 'sameRepoSlug' "$PREFIX_REPAIR/automerge-outcome.js" || true) sameRepoSlug references (expect 0)"
fi
echo

echo "== proof =="
node docs/proof/automerge-repo-case-sensitivity/run-proof.mjs ${PREFIX_REPAIR:+"$PREFIX_REPAIR"} \
  | tee "$ARTIFACT_DIR/proof-output.txt"

echo
echo "== focused regression suites =="
node --test \
  test/repair/automerge-outcome.test.ts \
  test/repair/execute-fix-github.test.ts \
  test/repair/post-flight.test.ts \
  test/repair/source-pr-checkout.test.ts 2>&1 | tail -8 | tee "$ARTIFACT_DIR/focused-tests.txt"

rm -rf "$PREFIX_DIR"
echo
echo "artifacts written to $ARTIFACT_DIR"
