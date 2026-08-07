#!/usr/bin/env bash
# Crabbox local-container proof for the stableJson canonical-ordering fix.
#
# Runs inside a Node 24 Linux container on the synced current checkout. It builds
# the repository, compiles the PRE-FIX src/stable-json.ts from the merge base so
# the churn claim is measured against real prior behavior rather than asserted,
# then runs run-proof.mjs and the focused suite.
set -euo pipefail

ARTIFACT_DIR=".artifacts/stable-json-canonical-proof"
mkdir -p "$ARTIFACT_DIR"
BASE_REF="${STABLE_JSON_PROOF_BASE:-0588bda9}"

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
pnpm run build >"$ARTIFACT_DIR/build.log" 2>&1 \
  || { echo "FAIL: pnpm run build"; tail -30 "$ARTIFACT_DIR/build.log"; exit 1; }
test -f dist/stable-json.js || { echo "FAIL: build did not produce dist/stable-json.js"; exit 1; }
# Count real calls, not the word where the module doc explains why it is not used.
echo "post-fix comparator: $(grep -c '\.localeCompare(' dist/stable-json.js || true) localeCompare CALLS (expect 0)"
echo

echo "== compile pre-fix stable-json from $BASE_REF =="
PREFIX_DIR="$(mktemp -d)"
git show "$BASE_REF:src/stable-json.ts" > "$PREFIX_DIR/stable-json.ts"
./node_modules/.bin/tsc "$PREFIX_DIR/stable-json.ts" --ignoreConfig \
  --target es2022 --module esnext --moduleResolution bundler --outDir "$PREFIX_DIR/out"
echo "pre-fix comparator: $(grep -c '\.localeCompare(' "$PREFIX_DIR/out/stable-json.js" || true) localeCompare CALLS (expect 1)"
echo

echo "== proof =="
node docs/proof/stable-json-canonical-ordering/run-proof.mjs "$PREFIX_DIR/out/stable-json.js" \
  | tee "$ARTIFACT_DIR/proof-output.txt"

echo
echo "== focused regression suite =="
node --test test/stable-json.test.ts 2>&1 | tail -8 | tee "$ARTIFACT_DIR/focused-tests.txt"

rm -rf "$PREFIX_DIR"
echo
echo "artifacts written to $ARTIFACT_DIR"
