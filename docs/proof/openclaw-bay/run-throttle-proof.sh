#!/usr/bin/env bash
set -euo pipefail

export BAY_THROTTLE_PROOF_ONLY=1
exec bash docs/proof/openclaw-bay/run-proof.sh
