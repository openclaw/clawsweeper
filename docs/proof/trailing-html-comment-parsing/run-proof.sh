#!/usr/bin/env bash
# Crabbox local-container proof for the trailing HTML comment parsing fix.
#
# Runs inside a Node 24 Linux container on the synced current checkout. It builds
# the repository, compiles the PRE-FIX review-comment-markers.ts from the merge
# base so the no-loss claim is measured rather than asserted, then runs
# run-proof.mjs and the focused suites.
set -euo pipefail

ARTIFACT_DIR=".artifacts/trailing-html-comment-proof"
mkdir -p "$ARTIFACT_DIR"

# Derive the merge base rather than pinning a SHA: a pinned base silently goes
# stale after a rebase and would compare the no-loss claim against an obsolete
# revision.
#
# Prefer MARKER_PROOF_BASE, computed on the host and passed in with --allow-env
# (the pattern docs/proof/openclaw-bay uses for BAY_PROOF_SOURCE_SHA). Deriving
# it inside the lease also works, but depends on lease-side git succeeding; that
# has been observed to fail transiently under heavy host I/O contention. Falling
# back keeps the script usable standalone while the env var makes a lease run
# deterministic.
BASE_REF="${MARKER_PROOF_BASE:-}"
BASE_SOURCE="MARKER_PROOF_BASE"
if [ -z "$BASE_REF" ]; then
  BASE_SOURCE="merge-base derived in-lease"
  BASE_ERR="$( { git merge-base HEAD origin/main || git merge-base HEAD main; } 2>&1 1>/dev/null || true )"
  BASE_REF="$( { git merge-base HEAD origin/main || git merge-base HEAD main; } 2>/dev/null || true )"
fi
if [ -z "$BASE_REF" ]; then
  echo "FAIL: could not determine the merge base with main."
  echo "      git said: ${BASE_ERR:-<no output>}"
  echo "      Re-run with the base computed on the host:"
  echo "        MARKER_PROOF_BASE=\"\$(git merge-base HEAD origin/main)\" \\"
  echo "        crabbox run ... --allow-env MARKER_PROOF_BASE ..."
  exit 1
fi
if ! git cat-file -e "$BASE_REF:src/review-comment-markers.ts" 2>/dev/null; then
  echo "FAIL: $BASE_REF does not contain src/review-comment-markers.ts;"
  echo "      the no-loss claim cannot be measured against it."
  exit 1
fi
echo "base ref: $BASE_REF (source: $BASE_SOURCE)"

echo "== environment =="
uname -a
node --version
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "FAIL: repository requires Node >= 24, got $(node --version)"
  exit 1
fi
echo "head: $(git rev-parse HEAD 2>/dev/null || echo 'unavailable')"
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
# TypeScript 7 dispatches to a platform-native binary published as an optional
# dependency. A lease that resolves optionals incompletely leaves tsc unable to
# start, which surfaces far from its cause - so check it explicitly here.
TS_PLATFORM_PKG="@typescript/typescript-$(node -p 'process.platform')-$(node -p 'process.arch')"
if [ ! -d "node_modules/$TS_PLATFORM_PKG" ]; then
  echo "NOTE: $TS_PLATFORM_PKG missing after install; fetching it explicitly"
  pnpm add -D --ignore-scripts "$TS_PLATFORM_PKG@$(node -p "require('./node_modules/typescript/package.json').version")" \
    >>"$ARTIFACT_DIR/install.log" 2>&1 || true
fi
test -d "node_modules/$TS_PLATFORM_PKG" \
  || { echo "FAIL: $TS_PLATFORM_PKG unavailable; tsc cannot run"; tail -30 "$ARTIFACT_DIR/install.log"; exit 1; }
echo "tsc platform package: $TS_PLATFORM_PKG present"
# build:node, not build: test/helpers.ts (used by the recovery suites) imports
# dist/clawsweeper.js and dist/review-activity-cursor.js from the main build.
pnpm run build:node >"$ARTIFACT_DIR/build.log" 2>&1 \
  || { echo "FAIL: pnpm run build:node"; tail -30 "$ARTIFACT_DIR/build.log"; exit 1; }
test -f dist/review-comment-markers.js || { echo "FAIL: markers build artifact missing"; exit 1; }
test -f dist/clawsweeper.js || { echo "FAIL: main build artifact missing"; exit 1; }
echo "post-fix guard: $(grep -c 'indexOf("-->"' dist/review-comment-markers.js || true) interior-terminator checks (expect 1)"
echo

echo "== compile pre-fix module from $BASE_REF =="
# review-comment-markers.ts has no imports, so it compiles standalone.
PREFIX_DIR="$(mktemp -d)"
mkdir -p "$PREFIX_DIR/src"
git show "$BASE_REF:src/review-comment-markers.ts" > "$PREFIX_DIR/src/review-comment-markers.ts"
./node_modules/.bin/tsc "$PREFIX_DIR/src/review-comment-markers.ts" --ignoreConfig \
  --target es2022 --module esnext --moduleResolution bundler --outDir "$PREFIX_DIR/out" \
  >"$ARTIFACT_DIR/prefix-build.log" 2>&1 || true
PREFIX_MARKERS="$PREFIX_DIR/out/review-comment-markers.js"
if [ ! -f "$PREFIX_MARKERS" ]; then
  PREFIX_MARKERS=""
  echo "pre-fix build: unavailable (no-loss claim reports SKIPPED and FAILS)"
  tail -20 "$ARTIFACT_DIR/prefix-build.log" 2>/dev/null || true
else
  echo "pre-fix guard: $(grep -c 'indexOf("-->"' "$PREFIX_MARKERS" || true) interior-terminator checks (expect 0)"
fi
echo

echo "== proof =="
node docs/proof/trailing-html-comment-parsing/run-proof.mjs ${PREFIX_MARKERS:+"$PREFIX_MARKERS"} \
  | tee "$ARTIFACT_DIR/proof-output.txt"

echo
echo "== focused regression suites =="
node --test \
  test/review-comment-markers.test.ts \
  test/review-recovery-label-backfill.test.ts \
  test/review-placeholder-recovery.test.ts 2>&1 | tail -8 | tee "$ARTIFACT_DIR/focused-tests.txt"

rm -rf "$PREFIX_DIR"
echo
echo "artifacts written to $ARTIFACT_DIR"
