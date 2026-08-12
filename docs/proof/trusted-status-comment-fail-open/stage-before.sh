#!/usr/bin/env bash
# Regenerate the committed pre-fix source used by the contrast in run-proof.sh.
#
# before/comment-router.ts is a verbatim copy of the base-commit blob. It is
# committed because container images carry no .git, so the pre-fix source cannot
# be recovered inside a lease. run-proof.sh rewrites it from git whenever git is
# reachable, so this script is only needed to refresh it after a rebase.
set -euo pipefail

PROOF_DIR="docs/proof/trusted-status-comment-fail-open"
SOURCE="src/repair/comment-router.ts"
BASE="${TRUST_PROOF_BASE:-0588bda9}"

mkdir -p "$PROOF_DIR/before"
git show "$BASE:$SOURCE" >"$PROOF_DIR/before/comment-router.ts"

echo "staged $PROOF_DIR/before/comment-router.ts"
echo "  base:   $(git rev-parse "$BASE")"
echo "  source: $SOURCE"
echo "  sha256: $(shasum -a 256 "$PROOF_DIR/before/comment-router.ts" | cut -d' ' -f1)"
