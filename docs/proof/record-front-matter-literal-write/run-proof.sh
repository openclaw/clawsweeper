#!/usr/bin/env bash
# Crabbox local-container proof for the record front matter literal-write fix.
#
# Runs inside a Node 24 Linux container on the synced current checkout. It builds
# the main lane and exercises the shipped record metadata factory
# (dist/clawsweeper-record-metadata.js) that the label apply lane writes `labels:`
# through.
#
# See run-proof.mjs for the fixtures and assertions.
set -euo pipefail

PROOF_DIR="docs/proof/record-front-matter-literal-write"
ARTIFACT_DIR=".artifacts/record-front-matter-literal-write-proof"
mkdir -p "$ARTIFACT_DIR"

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
# TypeScript ships its compiler as a per-platform optional dependency; on some
# arm64 hosts the frozen install resolves the package but not that binary.
node -e "require.resolve('typescript/package.json')" >/dev/null 2>&1 || {
  echo "FAIL: typescript missing after install"; exit 1;
}
# Any fallback must stay out of the checkout's tracked dependency metadata: a proof
# that edits package.json or pnpm-lock.yaml before it builds describes a tree that no
# longer matches the submitted head. Install into a disposable prefix outside the
# workspace and copy into node_modules/, which is untracked build state.
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
assert_tracked_state_clean "after dependency install"
pnpm run build:node >"$ARTIFACT_DIR/build.log" 2>&1 \
  || { echo "FAIL: pnpm run build:node"; tail -30 "$ARTIFACT_DIR/build.log"; exit 1; }
test -f dist/clawsweeper-record-metadata.js \
  || { echo "FAIL: build did not produce dist/clawsweeper-record-metadata.js"; exit 1; }
echo "shipped guard: $(node -p "/escapeRegExp/.test(require('fs').readFileSync('dist/clawsweeper-record-metadata.js','utf8'))")"
echo

echo "== before / after on the shipped parser =="
# Compile the pre-fix module from the merge base so the contrast is measured against
# real compiled code rather than a hand-written re-implementation. It is emitted into
# dist/ so its relative imports resolve against the already-built siblings.
# The container has no .git, so the pre-fix module is staged into the proof package
# by stage-before.sh on the host and rsynced in. When git *is* available the staged
# copy is re-derived and compared, so it can never drift from the base commit.
STAGED="$PROOF_DIR/before/record-metadata-before.ts"
BASE="${PROOF_BASE:-$(git rev-parse HEAD >/dev/null 2>&1 && (git merge-base HEAD main 2>/dev/null || git merge-base HEAD origin/main 2>/dev/null) || true)}"
if git rev-parse HEAD >/dev/null 2>&1 && [ -n "$BASE" ] \
   && git cat-file -e "$BASE:src/clawsweeper-record-metadata.ts" 2>/dev/null; then
  echo "base: $BASE (re-derived from git)"
  mkdir -p "$PROOF_DIR/before"
  git show "$BASE:src/clawsweeper-record-metadata.ts" >"$STAGED"
elif [ -f "$STAGED" ]; then
  echo "base: staged copy (no git in this environment)"
  echo "staged sha256: $(node -e "const c=require('crypto'),f=require('fs');process.stdout.write(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex'))" "$STAGED")"
else
  echo "FAIL: no pre-fix module. Run docs/proof/record-front-matter-literal-write/stage-before.sh first."
  exit 1
fi
cp "$STAGED" dist/record-metadata-before.ts
pnpm exec tsc dist/record-metadata-before.ts \
    --ignoreConfig --module nodenext --target es2023 --skipLibCheck \
  >"$ARTIFACT_DIR/before-build.log" 2>&1 || true
if [ -f dist/record-metadata-before.js ]; then
  set +e
  node "$PROOF_DIR/run-proof.mjs" --module dist/record-metadata-before.js \
    >"$ARTIFACT_DIR/before-output.txt" 2>&1
  BEFORE_STATUS=$?
  set -e
  echo "pre-fix exit: $BEFORE_STATUS (non-zero is the bug this PR fixes)"
  grep "^  FAIL" "$ARTIFACT_DIR/before-output.txt" || true
  # An ordinary label must already round-trip before the fix; that is what shows
  # this change only affects names carrying a replacement pattern.
  if grep -q '^  FAIL  labels \["bug"\]' "$ARTIFACT_DIR/before-output.txt"; then
    echo "FAIL: an ordinary label did not round-trip before the fix"
    exit 1
  fi
  if [ "$BEFORE_STATUS" -eq 0 ]; then
    echo "FAIL: the pre-fix module passed, so this proof does not demonstrate the fix"
    exit 1
  fi
else
  echo "FAIL: the pre-fix module did not compile"
  tail -10 "$ARTIFACT_DIR/before-build.log" || true
  exit 1
fi
echo

echo "== writer proof =="
node "$PROOF_DIR/run-proof.mjs" | tee "$ARTIFACT_DIR/proof-output.txt"

echo
echo "== focused regression suite =="
node --test test/clawsweeper-record-metadata.test.ts 2>&1 | tail -12 \
  | tee "$ARTIFACT_DIR/focused-tests.txt"

echo
echo "== tracked state after proof =="
# The closing check is what matters for review: it says the tree that produced
# every result above is still byte-for-byte the submitted head.
assert_tracked_state_clean "end of run"
cat "$TRACKED_BASELINE"
echo
echo "artifacts written to $ARTIFACT_DIR"
