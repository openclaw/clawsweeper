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
PROOF_DIR="docs/proof/trusted-status-comment-fail-open"
STAGED_PREFIX="$PROOF_DIR/before/comment-router.ts"
BASE_REF="${TRUST_PROOF_BASE:-0588bda9}"

echo "== tracked state at sync =="
# A proof is only evidence about the submitted head if the tree still *is* the
# submitted head when the assertions run. Record the tracked state up front and
# re-check it at every stage that could disturb it.
TRACKED_BASELINE="$ARTIFACT_DIR/tracked-state-before.txt"
capture_tracked_state() {
  {
    echo "head: ${PROOF_HEAD:-$(git rev-parse HEAD 2>/dev/null || echo unavailable)}"
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

# Container images carry no .git, so the pre-fix source cannot be recovered inside
# the lease. stage-before.sh writes it on the host as an *untracked* file and rsync
# carries it in; it is deliberately not committed, because it is a 5k-line verbatim
# copy of a blob git already stores. Where git *is* reachable it is re-derived here,
# so a stale copy cannot quietly weaken the contrast. Untracked paths are excluded
# from the tracked-state comparison, so staging cannot disturb the head being proven.
if git rev-parse HEAD >/dev/null 2>&1 \
   && git cat-file -e "$BASE_REF:src/repair/comment-router.ts" 2>/dev/null; then
  mkdir -p "$PROOF_DIR/before"
  git show "$BASE_REF:src/repair/comment-router.ts" >"$STAGED_PREFIX"
  echo "pre-fix source: re-derived from git at $BASE_REF"
elif [ -s "$STAGED_PREFIX" ]; then
  echo "pre-fix source: staged copy (no git in this environment)"
  echo "fixture sha256: $(sha256sum "$STAGED_PREFIX" | cut -d' ' -f1)"
else
  echo "FAIL: no pre-fix copy of src/repair/comment-router.ts is available,"
  echo "      so the before/after contrast cannot be measured. Stage it first:"
  echo "        bash $PROOF_DIR/stage-before.sh"
  exit 1
fi
assert_tracked_state_clean "after pre-fix fixture check"
echo

echo "== environment =="
uname -a
node --version
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "FAIL: repository requires Node >= 24, got $(node --version)"
  exit 1
fi
# A container image carries no .git, so `git rev-parse` cannot name the commit under
# test from inside the lease. PROOF_HEAD is computed on the host and forwarded with
# --allow-env so the recorded output states which head it describes; the host must
# verify the tree is clean before the run for that to mean anything.
echo "head: ${PROOF_HEAD:-$(git rev-parse HEAD 2>/dev/null || echo 'unavailable (pass PROOF_HEAD)')}"
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
#
# The fallback must never touch the checkout's tracked dependency metadata: a
# proof that edits package.json or pnpm-lock.yaml before it builds is describing a
# tree that no longer matches the submitted head. So it installs into a disposable
# prefix outside the workspace (the pattern docs/proof/openclaw-bay uses for
# Playwright) and copies the result into node_modules/, which is untracked build
# state. `assert_tracked_state_clean` below proves it worked.
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
# build:node, not build:repair: test/helpers.ts imports dist/clawsweeper.js.
pnpm run build:node >"$ARTIFACT_DIR/build.log" 2>&1 \
  || { echo "FAIL: pnpm run build:node"; tail -30 "$ARTIFACT_DIR/build.log"; exit 1; }
test -f dist/repair/comment-router-core.js || { echo "FAIL: repair build artifact missing"; exit 1; }
test -f dist/clawsweeper.js || { echo "FAIL: main build artifact missing"; exit 1; }
echo "post-fix guard: $(grep -c 'isTrustedStatusCommentAuthor' dist/repair/comment-router-core.js || true) shared comparator references (expect >0)"
echo

echo "== pre-fix source from $BASE_REF =="
# The pre-fix predicate was module-private, so the proof reads its source text and
# asserts its own reimplementation is faithful. No compile or eval is needed.
PREFIX_SRC="$STAGED_PREFIX"
echo "pre-fix fail-open clause present: $(grep -c 'return !author ||' "$PREFIX_SRC" || true) (expect 1)"
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

echo
echo "== tracked state after proof =="
# The closing check is the one that matters for review: it says the tree that
# produced every result above is still byte-for-byte the submitted head.
assert_tracked_state_clean "end of run"
cat "$TRACKED_BASELINE"
echo
echo "artifacts written to $ARTIFACT_DIR"
