#!/usr/bin/env bash
# Stage the pre-fix module for the before/after contrast in run-proof.sh.
#
# Run this on the host before handing the proof to a Crabbox lease. Container
# images carry no .git, so the base version of the changed file has to travel with
# the synced workspace. The staged file is untracked and rsynced as a dirty file;
# run-proof.sh re-derives and overwrites it whenever git *is* available, so it can
# never drift from the base commit.
set -euo pipefail

PROOF_DIR="docs/proof/record-front-matter-literal-write"
SOURCE="src/clawsweeper-record-metadata.ts"
BASE="${PROOF_BASE:-$(git merge-base HEAD main 2>/dev/null || git merge-base HEAD origin/main)}"

mkdir -p "$PROOF_DIR/before"
git show "$BASE:$SOURCE" >"$PROOF_DIR/before/record-metadata-before.ts"

echo "staged $PROOF_DIR/before/record-metadata-before.ts"
echo "  base:   $BASE"
echo "  source: $SOURCE"
echo "  sha256: $(shasum -a 256 "$PROOF_DIR/before/record-metadata-before.ts" | cut -d' ' -f1)"
