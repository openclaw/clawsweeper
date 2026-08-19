#!/usr/bin/env bash
# Regenerate the committed pre-fix source used by the contrast in run-proof.sh.
#
# before/comment-router.ts is a verbatim copy of the base-commit blob. It is written
# here as an *untracked* file and rsynced into the lease, because container images
# carry no .git and the pre-fix source cannot be recovered inside one. It is
# deliberately not committed: it is a 5,400-line duplicate of production code that
# git already stores, and the docs/ retention rule asks proof records to stay light.
#
# Because it is untracked, writing it cannot alter the head under test - the
# tracked-state guard in run-proof.sh ignores untracked paths and would abort if a
# tracked file moved.
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
