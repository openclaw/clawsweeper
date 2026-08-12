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
echo "== tracked state at sync =="
# A proof is only evidence about the submitted head if the tree still *is* the
# submitted head when the assertions run. Record the tracked state up front and
# re-check it at every stage that could disturb it.
TRACKED_BASELINE="$ARTIFACT_DIR/tracked-state-before.txt"
capture_tracked_state() {
  {
    echo "head: $(git rev-parse HEAD 2>/dev/null || echo unavailable)"
    echo "package.json sha256: $(sha256sum package.json | cut -d' ' -f1)"
    echo "pnpm-lock.yaml sha256: $(sha256sum pnpm-lock.yaml | cut -d' ' -f1)"
    echo "porcelain:"
    git status --porcelain 2>/dev/null | grep -v '^?? ' || true
  }
}
assert_tracked_state_clean() {
  local stage="$1" current="$ARTIFACT_DIR/tracked-state-current.txt"
  capture_tracked_state >"$current"
  if ! diff -u "$TRACKED_BASELINE" "$current" >"$ARTIFACT_DIR/tracked-state-diff.txt"; then
    echo "FAIL: the checkout's tracked state changed ($stage)."
    echo "      The recorded result would describe a tree other than the submitted head."
    cat "$ARTIFACT_DIR/tracked-state-diff.txt"
    exit 1
  fi
  echo "tracked state unchanged ($stage)"
}
capture_tracked_state | tee "$TRACKED_BASELINE"
echo

PROOF_DIR="docs/proof/trailing-html-comment-parsing"
STAGED_PREFIX="$PROOF_DIR/before/review-comment-markers.ts"

BASE_REF="${MARKER_PROOF_BASE:-}"
BASE_SOURCE="MARKER_PROOF_BASE"
if [ -z "$BASE_REF" ] && git rev-parse HEAD >/dev/null 2>&1; then
  BASE_SOURCE="merge-base derived in-lease"
  BASE_REF="$( { git merge-base HEAD main || git merge-base HEAD origin/main; } 2>/dev/null || true )"
fi

# Container images carry no .git, so the pre-fix source has to travel with the
# synced workspace. It is therefore committed under before/ as a verbatim copy of
# the base-commit blob. Where git *is* available the copy is re-derived and
# rewritten, so a stale fixture cannot silently weaken the contrast; the
# tracked-state guard below then fails the run if that rewrite changed anything.
if git rev-parse HEAD >/dev/null 2>&1 && [ -n "$BASE_REF" ] \
   && git cat-file -e "$BASE_REF:src/review-comment-markers.ts" 2>/dev/null; then
  mkdir -p "$PROOF_DIR/before"
  git show "$BASE_REF:src/review-comment-markers.ts" >"$STAGED_PREFIX"
  echo "base ref: $BASE_REF (source: $BASE_SOURCE, re-derived from git)"
elif [ -f "$STAGED_PREFIX" ]; then
  BASE_SOURCE="staged copy (no git in this environment)"
  echo "base ref: ${BASE_REF:-<recorded by stage-before.sh>} (source: $BASE_SOURCE)"
  echo "staged sha256: $(sha256sum "$STAGED_PREFIX" | cut -d' ' -f1)"
else
  echo "FAIL: no pre-fix copy of src/review-comment-markers.ts is available,"
  echo "      so the no-loss claim cannot be measured. Stage it on the host first:"
  echo "        bash $PROOF_DIR/stage-before.sh"
  exit 1
fi
# The git branch above rewrites before/ from the base blob. Checking here - after
# that rewrite but before anything is built - is what makes a stale committed
# fixture a hard failure instead of a silently weaker contrast.
assert_tracked_state_clean "after pre-fix fixture check"

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
#
# The fallback must never touch the checkout's tracked dependency metadata: a
# proof that edits package.json or pnpm-lock.yaml before it builds is describing
# a tree that no longer matches the submitted head. So it installs into a
# disposable prefix outside the workspace (the pattern docs/proof/openclaw-bay
# uses for Playwright) and links the result into node_modules/, which is
# untracked build state. `assert_tracked_state_clean` below proves it worked.
TS_PLATFORM_PKG="@typescript/typescript-$(node -p 'process.platform')-$(node -p 'process.arch')"
if [ ! -d "node_modules/$TS_PLATFORM_PKG" ]; then
  echo "NOTE: $TS_PLATFORM_PKG missing after install; fetching it into a disposable prefix"
  TS_FALLBACK_DIR="$(mktemp -d)"
  TS_VERSION="$(node -p "require('./node_modules/typescript/package.json').version")"
  npm install --prefix "$TS_FALLBACK_DIR" --no-save --no-audit --no-fund --ignore-scripts \
    "$TS_PLATFORM_PKG@$TS_VERSION" >>"$ARTIFACT_DIR/install.log" 2>&1 || true
  if [ -d "$TS_FALLBACK_DIR/node_modules/$TS_PLATFORM_PKG" ]; then
    mkdir -p "node_modules/$(dirname "$TS_PLATFORM_PKG")"
    cp -R "$TS_FALLBACK_DIR/node_modules/$TS_PLATFORM_PKG" "node_modules/$TS_PLATFORM_PKG"
    echo "fallback source: $TS_FALLBACK_DIR (outside the workspace)"
  fi
  rm -rf "$TS_FALLBACK_DIR"
fi
test -d "node_modules/$TS_PLATFORM_PKG" \
  || { echo "FAIL: $TS_PLATFORM_PKG unavailable; tsc cannot run"; tail -30 "$ARTIFACT_DIR/install.log"; exit 1; }
echo "tsc platform package: $TS_PLATFORM_PKG present"
assert_tracked_state_clean "after dependency install"
# build:node, not build: test/helpers.ts (used by the recovery suites) imports
# dist/clawsweeper.js and dist/review-activity-cursor.js from the main build.
pnpm run build:node >"$ARTIFACT_DIR/build.log" 2>&1 \
  || { echo "FAIL: pnpm run build:node"; tail -30 "$ARTIFACT_DIR/build.log"; exit 1; }
test -f dist/review-comment-markers.js || { echo "FAIL: markers build artifact missing"; exit 1; }
test -f dist/clawsweeper.js || { echo "FAIL: main build artifact missing"; exit 1; }
echo "post-fix guard: $(grep -c 'indexOf("-->"' dist/review-comment-markers.js || true) interior-terminator checks (expect 1)"
echo

echo "== compile pre-fix module from ${BASE_REF:-the staged copy} =="
# review-comment-markers.ts has no imports, so it compiles standalone.
PREFIX_DIR="$(mktemp -d)"
mkdir -p "$PREFIX_DIR/src"
cp "$STAGED_PREFIX" "$PREFIX_DIR/src/review-comment-markers.ts"
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
echo "== tracked state after proof =="
# The closing check is the one that matters for review: it says the tree that
# produced every result above is still byte-for-byte the submitted head.
assert_tracked_state_clean "end of run"
cat "$TRACKED_BASELINE"
echo
echo "artifacts written to $ARTIFACT_DIR"
