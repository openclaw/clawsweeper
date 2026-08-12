#!/usr/bin/env bash
# Stage the pre-fix module for the no-loss contrast in run-proof.sh.
#
# Run this on the host before handing the proof to a Crabbox lease. Container
# images carry no .git, so the base version of the changed file has to travel
# with the synced workspace. The staged file is untracked, so it does not alter
# the head being proven; run-proof.sh re-derives it whenever git *is* available.
set -euo pipefail

PROOF_DIR="docs/proof/trailing-html-comment-parsing"
SOURCE="src/review-comment-markers.ts"
BASE="${MARKER_PROOF_BASE:-$(git merge-base HEAD main 2>/dev/null || git merge-base HEAD origin/main)}"

mkdir -p "$PROOF_DIR/before"
git show "$BASE:$SOURCE" >"$PROOF_DIR/before/review-comment-markers.ts"

echo "staged $PROOF_DIR/before/review-comment-markers.ts"
echo "  base:   $BASE"
echo "  source: $SOURCE"
echo "  sha256: $(shasum -a 256 "$PROOF_DIR/before/review-comment-markers.ts" | cut -d' ' -f1)"
