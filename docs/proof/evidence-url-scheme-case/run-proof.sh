#!/usr/bin/env bash
# Crabbox local-container proof for the evidence external-URL scheme-case fix.
#
# Runs inside a Node 24 Linux container on the synced current checkout. It builds
# the repair lane, then exercises both shipped surfaces:
#
#   1. sanitizeResultEvidence()      - dist/repair/url-safety.js
#   2. dist/repair/review-results.js - run as a real CLI subprocess, exactly as
#                                      dist/repair/run-worker.js invokes it
#
# See run-proof.mjs for the fixture and assertions.
set -euo pipefail

ARTIFACT_DIR=".artifacts/evidence-url-scheme-proof"
mkdir -p "$ARTIFACT_DIR"

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
pnpm run build:repair >"$ARTIFACT_DIR/build.log" 2>&1 \
  || { echo "FAIL: pnpm run build:repair"; tail -30 "$ARTIFACT_DIR/build.log"; exit 1; }
test -f dist/repair/url-safety.js || { echo "FAIL: build did not produce dist/repair/url-safety.js"; exit 1; }
echo "url-safety scheme flag: $(node -p "require('fs').readFileSync('dist/repair/url-safety.js','utf8').match(/const URL_PATTERN = .*/)[0]")"
echo

echo "== sanitizer + validator proof =="
node docs/proof/evidence-url-scheme-case/run-proof.mjs | tee "$ARTIFACT_DIR/proof-output.txt"

echo
echo "== focused regression suite =="
node --test test/repair/url-safety.test.ts 2>&1 | tail -8 | tee "$ARTIFACT_DIR/focused-tests.txt"

echo
echo "artifacts written to $ARTIFACT_DIR"
