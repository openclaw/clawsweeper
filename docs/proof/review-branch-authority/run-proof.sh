#!/usr/bin/env bash
set -euo pipefail

export CI=1
export WRANGLER_SEND_METRICS=false

pnpm install --frozen-lockfile
pnpm run build:dashboard
node docs/proof/review-branch-authority/run-proof.mjs
