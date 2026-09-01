#!/usr/bin/env bash
set -euo pipefail
proof_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
exec node "$proof_dir/run-proof.mjs" "$@"
