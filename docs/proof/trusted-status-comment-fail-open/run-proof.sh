#!/usr/bin/env bash
# Crabbox local-container proof for the trusted-status-comment fail-open fix.
#
# Runs inside a Node 24 Linux container on the synced current checkout. It builds
# the repository, extracts the PRE-FIX predicate source from the merge base so the
# before/after contrast is measured rather than asserted, then runs run-proof.mjs
# and the focused suites.
set -euo pipefail

ARTIFACT_DIR=".artifacts/trusted-status-comment-proof"
mkdir -p "$ARTIFACT_DIR"
BASE_REF="${TRUST_PROOF_BASE:-0588bda9}"

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
# build:node, not build:repair: test/helpers.ts imports dist/clawsweeper.js.
pnpm run build:node >"$ARTIFACT_DIR/build.log" 2>&1 \
  || { echo "FAIL: pnpm run build:node"; tail -30 "$ARTIFACT_DIR/build.log"; exit 1; }
test -f dist/repair/comment-router-core.js || { echo "FAIL: repair build artifact missing"; exit 1; }
test -f dist/clawsweeper.js || { echo "FAIL: main build artifact missing"; exit 1; }
echo "post-fix guard: $(grep -c 'isTrustedStatusCommentAuthor' dist/repair/comment-router-core.js || true) shared comparator references (expect >0)"
echo

echo "== extract pre-fix source from $BASE_REF =="
# The pre-fix predicate was module-private, so the proof reads its source text and
# asserts its own reimplementation is faithful. No compile or eval is needed.
PREFIX_DIR="$(mktemp -d)"
PREFIX_SRC="$PREFIX_DIR/comment-router.ts"
git show "$BASE_REF:src/repair/comment-router.ts" > "$PREFIX_SRC" 2>"$ARTIFACT_DIR/prefix-extract.log" || true
if [ ! -s "$PREFIX_SRC" ]; then
  PREFIX_SRC=""
  echo "pre-fix source: unavailable (contrast reports SKIPPED and FAILS)"
  tail -20 "$ARTIFACT_DIR/prefix-extract.log" 2>/dev/null || true
else
  echo "pre-fix fail-open clause present: $(grep -c 'return !author ||' "$PREFIX_SRC" || true) (expect 1)"
fi
echo

echo "== proof =="
node docs/proof/trusted-status-comment-fail-open/run-proof.mjs ${PREFIX_SRC:+"$PREFIX_SRC"} \
  | tee "$ARTIFACT_DIR/proof-output.txt"

echo
echo "== focused regression suites =="
node --test \
  test/repair/comment-router-core.test.ts \
  test/repair/comment-router-utils.test.ts \
  test/repair/execute-fix-artifact-source.test.ts 2>&1 | tail -8 | tee "$ARTIFACT_DIR/focused-tests.txt"

rm -rf "$PREFIX_DIR"
echo
echo "artifacts written to $ARTIFACT_DIR"
