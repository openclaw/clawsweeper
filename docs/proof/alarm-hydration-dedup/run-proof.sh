#!/usr/bin/env bash
set -euo pipefail

corepack enable
exec node docs/proof/alarm-hydration-dedup/run-proof.mjs
