#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

corepack enable
pnpm install --frozen-lockfile
node docs/proof/bounded-status-store-reads/run-proof.mjs
