#!/usr/bin/env bash
set -euo pipefail

expected_head="${1:?expected head is required}"
expected_base="${2:?expected merge base is required}"

test "$(git rev-parse HEAD)" = "$expected_head"
test "$(git merge-base HEAD origin/main)" = "$expected_base"
git cat-file -e "${expected_head}^{commit}"
git cat-file -e "${expected_base}^{commit}"

echo CRABBOX_PHASE:install
corepack enable
pnpm install --frozen-lockfile

echo CRABBOX_PHASE:build
pnpm run build:all

echo CRABBOX_PHASE:focused
node --test test/github-etag-read-broker.test.ts test/github-egress-telemetry.test.ts

echo CRABBOX_PHASE:loopback
mkdir -p .artifacts/etag-read-broker
node docs/proof/etag-read-broker/run-proof.mjs \
  --output .artifacts/etag-read-broker/behavior-report.json
jq -e '
  .schema == "clawsweeper-etag-read-broker-proof/v1" and
  .tested_head == $head and
  .merge_base == $base and
  .results.first_read == "200_stored" and
  .results.unchanged_read == "304_confirmed_body_served" and
  .results.byte_identical == true and
  .results.digest_asserted == true and
  .results.changed_read == "200_replaced" and
  .results.page_2_carried_page_1_etag == false and
  .results.final_guard_revalidated == true and
  .results.bare_cache_reads == 0 and
  .results.wire_calls == 5 and
  .results.quota_charges == 3 and
  .results.telemetry.cache_200_stored == 3 and
  .results.telemetry.cache_304_served == 2 and
  .results.telemetry.cache_hit == 3 and
  .results.telemetry.cache_miss == 2 and
  .results.telemetry.cache_skip == 0 and
  .results.publisher_hmac_status == 200 and
  .results.operator_hmac_status == 401
' --arg head "$expected_head" --arg base "$expected_base" \
  .artifacts/etag-read-broker/behavior-report.json >/dev/null

echo CRABBOX_PHASE:dashboard_strict
pnpm run check:dashboard-strict

echo CRABBOX_PHASE:full_gate
pnpm run check

echo "ETAG_READ_BROKER_PROOF_OK head=$expected_head base=$expected_base"
