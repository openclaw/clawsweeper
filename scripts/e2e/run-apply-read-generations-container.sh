#!/usr/bin/env bash
set -euo pipefail

corepack enable
pnpm install --frozen-lockfile
pnpm run build
node scripts/e2e/apply-read-generations-loopback.mjs
