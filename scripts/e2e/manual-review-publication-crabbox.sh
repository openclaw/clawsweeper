#!/usr/bin/env bash
set -euo pipefail

# Runs inside a parent-owned Crabbox lease; allocates no resources or credentials.
if [[ ${BASH_VERSINFO[0]} -lt 4 ]]; then echo 'Bash 4+ required' >&2; exit 2; fi
if [[ ! ${1:-} =~ ^[0-9a-f]{40}$ || ! ${2:-} =~ ^[0-9a-f]{64}$ ]]; then
  echo 'usage: manual-review-publication-crabbox.sh <base-commit> <candidate-source-sha256>' >&2
  exit 2
fi
: "${MANUAL_PUBLICATION_WRANGLER:?absolute path to installed Wrangler 4.107.0 required}"
: "${MANUAL_PUBLICATION_GH:?absolute path to stock GitHub CLI required; no credential wrappers}"
: "${MANUAL_PUBLICATION_PROVIDER:?parent must supply actual provider}"
: "${MANUAL_PUBLICATION_LEASE:?parent must supply actual lease id}"
: "${MANUAL_PUBLICATION_IMAGE:?parent must supply image identity}"
export WRANGLER_SEND_METRICS=false
node scripts/e2e/manual-review-publication.mjs verify-source "$1" "$2"
echo CRABBOX_PHASE:build
pnpm run build:all
echo CRABBOX_PHASE:behavior
node scripts/e2e/manual-review-publication.mjs run "$1" "$2"
