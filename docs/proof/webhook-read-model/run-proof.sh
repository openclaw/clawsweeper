#!/usr/bin/env bash
set -euo pipefail

expected_head="${1:?expected head is required}"
expected_base="${2:?expected merge base is required}"

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  git init --quiet
  git remote add origin https://github.com/openclaw/clawsweeper.git
  git fetch --quiet --depth=32 origin steipete/webhook-read-model main
  git reset --mixed --quiet "$expected_head"
  git diff --exit-code -- .
fi

test "$(git rev-parse HEAD)" = "$expected_head"
test "$(git merge-base HEAD origin/main)" = "$expected_base"
git cat-file -e "${expected_head}^{commit}"
git cat-file -e "${expected_base}^{commit}"

echo CRABBOX_PHASE:install
sudo corepack enable
pnpm install --frozen-lockfile

echo CRABBOX_PHASE:build
pnpm run build:all

echo CRABBOX_PHASE:focused
node --test \
  test/github-webhook-read-model.test.ts \
  test/live-read-generation.test.ts \
  test/review-placeholder-recovery.test.ts \
  test/repair/comment-router-read-model.test.ts \
  test/dashboard-worker-webhook-ingress.test.ts

echo CRABBOX_PHASE:loopback
mkdir -p .artifacts/webhook-read-model
node docs/proof/webhook-read-model/run-proof.mjs \
  --output .artifacts/webhook-read-model/behavior-report.json
jq -e '
  .schema == "clawsweeper-webhook-read-model-proof/v1" and
  .tested_head == $head and
  .merge_base == $base and
  (.ingress.event_classes | length) == 8 and
  .ingress.signed_loopback == true and
  .ingress.duplicate_guid_deduped == true and
  .ingress.object_watermark_monotonic == true and
  .ingress.late_comment_edit_cannot_resurrect_tombstone == true and
  .ingress.ttl_staleness_marked == true and
  .ingress.count_gap_forces_repair == true and
  .ingress.complete_repair_heals_gap == true and
  .ingress.partial_workflow_snapshot_rejected == true and
  .ingress.complete_run_census_required == true and
  .ingress.per_run_job_coverage_required == true and
  .pollers.planning_item.decisions_identical == true and
  .pollers.planning_item.poll_github_requests == 1 and
  .pollers.planning_item.snapshot_github_requests == 0 and
  .pollers.dashboard_workflow_health.decisions_identical == true and
  .pollers.dashboard_workflow_health.poll_github_requests == 8 and
  .pollers.dashboard_workflow_health.snapshot_github_requests == 0 and
  .pollers.placeholder_discovery.decisions_identical == true and
  .pollers.placeholder_discovery.poll_github_requests == 3 and
  .pollers.placeholder_discovery.snapshot_github_requests == 0 and
  .pollers.repair_loop_router.decisions_identical == true and
  .pollers.repair_loop_router.poll_github_requests == 1 and
  .pollers.repair_loop_router.snapshot_github_requests == 0 and
  .safety.apply_generation_live_hits == 1 and
  .safety.final_bypass_live_hits == 1 and
  .safety.read_model_guard_hits == 0 and
  .safety.exact_review_lease_reader_authorized == true and
  .safety.exact_review_webhook_secret_exposed == false and
  .subscriptions.readiness_is_per_event_class == true and
  .subscriptions.never_observed_degrades_to_poll == true and
  .openclaw_bay.affected == false
' --arg head "$expected_head" --arg base "$expected_base" \
  .artifacts/webhook-read-model/behavior-report.json >/dev/null

echo CRABBOX_PHASE:dashboard_strict
pnpm run check:dashboard-strict

echo CRABBOX_PHASE:full_gate
pnpm run check

echo "WEBHOOK_READ_MODEL_PROOF_OK head=$expected_head base=$expected_base"
