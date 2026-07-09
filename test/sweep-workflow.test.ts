import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { makeTreeReadOnlyForTest, restoreTreeModesForTest } from "../dist/clawsweeper.js";
import { readText, tmpPrefix } from "./helpers.ts";

test("sweep keeps optional media tooling out of review startup", () => {
  const workflow = readText(".github/workflows/sweep.yml");

  assert.doesNotMatch(workflow, /setup-media-proof-tools/);
});

test("review workflow gives Codex a read-only inspection token", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const eventReviewJobStart = workflow.indexOf("\n  event-review-apply:");
  const planJobStart = workflow.indexOf("\n  plan:", eventReviewJobStart);
  const eventReviewJob = workflow.slice(eventReviewJobStart, planJobStart);
  const reviewJobStart = workflow.indexOf("\n  review:");
  const publishJobStart = workflow.indexOf("\n  publish:", reviewJobStart);
  const reviewJob = workflow.slice(reviewJobStart, publishJobStart);
  const exactReviewStart = eventReviewJob.indexOf("- name: Review exact event item");
  const stateTokenStart = eventReviewJob.indexOf("- name: Create state token", exactReviewStart);
  const exactReviewStep = eventReviewJob.slice(exactReviewStart, stateTokenStart);

  assert.match(workflow, /id: codex-inspection-token/);
  assert.match(workflow, /permission-issues: read/);
  assert.match(workflow, /CLAWSWEEPER_PROOF_INSPECTION_TOKEN/);
  assert.match(
    exactReviewStep,
    /CLAWSWEEPER_PROOF_INSPECTION_TOKEN: \$\{\{ steps\.target-read-token\.outputs\.token \|\| github\.token \}\}/,
  );
  assert.match(reviewJob, /uses: \.\/clawsweeper\/\.github\/actions\/setup-codex/);
  assert.doesNotMatch(reviewJob, /uses: \.\/\.github\/actions\/setup-codex/);
});

test("dashboard syncs Worker secrets with durable lifecycle storage", () => {
  const workflow = readText(".github/workflows/dashboard.yml");
  const config = readText("dashboard/wrangler.toml");

  assert.doesNotMatch(workflow, /storage\/kv\/namespaces/);
  assert.match(config, /\[\[durable_objects\.bindings\]\]/);
  assert.match(config, /name = "STATUS_STORE"/);
  assert.match(config, /class_name = "StatusStore"/);
  assert.match(config, /new_sqlite_classes = \["StatusStore"\]/);
  assert.match(workflow, /workers\/scripts\/\$CLOUDFLARE_WORKER_NAME\/secrets-bulk/);
  assert.match(workflow, /Content-Type: application\/merge-patch\+json/);
  assert.match(workflow, /jq -e '\.success == true'/);
  assert.doesNotMatch(workflow, /wrangler@[^\s]+ secret bulk/);
});

test("publish workflow installs Codex from the root checkout path", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const publishJobStart = workflow.indexOf("\n  publish:");
  const recoverJobStart = workflow.indexOf("\n  recover-review-failures:", publishJobStart);
  const publishJob = workflow.slice(publishJobStart, recoverJobStart);

  assert.match(publishJob, /uses: \.\/\.github\/actions\/setup-codex/);
  assert.doesNotMatch(publishJob, /uses: \.\/clawsweeper\/\.github\/actions\/setup-codex/);
  const setupCodexStart = publishJob.indexOf("- uses: ./.github/actions/setup-codex");
  const syncCommentsStart = publishJob.indexOf("- name: Sync selected review comments");
  const applySelectedStart = publishJob.indexOf("- name: Apply selected safe close proposals");
  assert.ok(setupCodexStart > syncCommentsStart);
  assert.ok(applySelectedStart > setupCodexStart);
  assert.match(
    publishJob.slice(setupCodexStart, applySelectedStart),
    /if: \$\{\{ success\(\) && steps\.target-write-token\.outputs\.token != '' && github\.event\.inputs\.apply_after_review == 'true' \}\}/,
  );
});

test("apply workflow installs Codex only when proof-eligible apply work can run", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const applyJobStart = workflow.indexOf("\n  apply-existing:");
  assert.notEqual(applyJobStart, -1);
  const applyJob = workflow.slice(applyJobStart);
  const reconcileStart = applyJob.indexOf("- name: Reconcile before apply preselect");
  const preselectStart = applyJob.indexOf("- name: Preselect apply work that can need Codex");
  const setupCodexStart = applyJob.indexOf("- uses: ./.github/actions/setup-codex", preselectStart);
  const applyStart = applyJob.indexOf(
    "- name: Apply unchanged proposed decisions with checkpoints",
  );

  assert.ok(reconcileStart !== -1);
  assert.ok(preselectStart !== -1);
  assert.ok(preselectStart > reconcileStart);
  assert.ok(setupCodexStart > preselectStart);
  assert.ok(applyStart > setupCodexStart);
  const reconcileBlock = applyJob.slice(reconcileStart, preselectStart);
  assert.match(reconcileBlock, /GH_TOKEN: \$\{\{ steps\.target-write-token\.outputs\.token \}\}/);
  assert.match(reconcileBlock, /pnpm run reconcile -- "\$\{reconcile_args\[@\]\}"/);
  assert.match(
    applyJob.slice(setupCodexStart, applyStart),
    /if: \$\{\{ steps\.apply-preselect\.outputs\.needs_codex == 'true' \}\}/,
  );
  const preselectBlock = applyJob.slice(preselectStart, setupCodexStart);
  assert.match(preselectBlock, /\[ "\$sync_comments_only" = "true" \]/);
  assert.match(preselectBlock, /comment-sync-batch/);
  assert.match(preselectBlock, /batch_count="\$\(awk -F=/);
  const syncOnlyStart = preselectBlock.indexOf('if [ "$sync_comments_only" = "true" ]; then');
  assert.ok(syncOnlyStart !== -1);
  const nonSyncMatch = /\n\s+else\n\s+proof_args=\(/.exec(preselectBlock.slice(syncOnlyStart));
  assert.ok(nonSyncMatch);
  const nonSyncStart = syncOnlyStart + nonSyncMatch.index;
  assert.ok(nonSyncStart > syncOnlyStart);
  assert.doesNotMatch(preselectBlock.slice(syncOnlyStart, nonSyncStart), /needs_codex=true/);
  assert.match(preselectBlock, /\[ -n "\$item_numbers" \]/);
  assert.match(preselectBlock, /proposed-pr-close-coverage-item-numbers/);
  assert.match(preselectBlock, /proof_args\+=\(--item-numbers "\$item_numbers"\)/);
  assert.match(preselectBlock, /if \[ -n "\$selected" \]; then\s+needs_codex=true/);
  assert.doesNotMatch(preselectBlock, /if \[ -n "\$item_numbers" \]; then\s+needs_codex=true/);
  assert.doesNotMatch(preselectBlock, /normalized_apply_close_reasons=/);
});

test("apply workflow target token can inspect source workflow runs", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const applyJob = workflow.slice(workflow.indexOf("\n  apply-existing:"));
  const tokenStart = applyJob.indexOf("- name: Create target write token");
  const stateTokenStart = applyJob.indexOf("- name: Create state token", tokenStart);

  assert.ok(tokenStart !== -1);
  assert.ok(stateTokenStart > tokenStart);
  assert.match(applyJob.slice(tokenStart, stateTokenStart), /permission-actions: read/);
});

test("apply workflow bounds checkpoints and requeues with a fresh token", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const applyHelper = readText("scripts/apply-workflow-helpers.sh");
  const inputBlock = workflow.slice(
    workflow.indexOf("  workflow_dispatch:\n    inputs:"),
    workflow.indexOf("\n  schedule:"),
  );
  const applyJob = workflow.slice(workflow.indexOf("\n  apply-existing:"));
  const applyStep = applyJob.slice(
    applyJob.indexOf("- name: Apply unchanged proposed decisions with checkpoints"),
    applyJob.indexOf("- name: Commit apply results"),
  );
  const continueStep = applyJob.slice(
    applyJob.indexOf("- name: Continue apply sweep"),
    applyJob.indexOf("- name: Queue review backstops"),
  );
  const runMarker = "        run: |\n";
  const runBodyStart = applyStep.indexOf(runMarker);
  assert.notEqual(runBodyStart, -1);
  const runBody = applyStep
    .slice(runBodyStart + runMarker.length)
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");

  assert.match(workflow, /format\('Apply default ClawSweeper closures for \{0\}'/);
  assert.match(workflow, /format\('Apply custom ClawSweeper closures for \{0\}'/);
  assert.match(
    workflow,
    /github\.event\.schedule == '8,23,38,53 \* \* \* \*'\) && 'openclaw\/clawhub'/,
  );
  assert.match(inputBlock, /apply_limit:[\s\S]*default: "20"/);
  assert.match(inputBlock, /apply_checkpoint_size:[\s\S]*default: "20"/);
  assert.match(workflow, /github\.event\.inputs\.apply_limit != '20'/);
  assert.match(workflow, /github\.event\.inputs\.apply_checkpoint_size != '20'/);
  assert.match(applyStep, /Capping apply checkpoint size at 20/);
  assert.match(applyStep, /base_close_processed_limit=300/);
  assert.match(applyHelper, /coverage_proof_limit=1/);
  assert.match(applyHelper, /max_runtime_arg=\(--max-runtime-ms 600000\)/);
  assert.match(applyHelper, /max_close_processed_limit=900/);
  assert.match(applyStep, /close_processed_limit="\$base_close_processed_limit"/);
  assert.match(applyStep, /source scripts\/apply-workflow-helpers\.sh/);
  assert.match(applyStep, /select_adaptive_apply_batch/);
  assert.match(applyHelper, /adaptive-apply-batch-size/);
  assert.match(applyHelper, /--status-path "results\/sweep-status\/\$\{target_slug\}\.json"/);
  assert.ok(
    runBody.length < 20_000,
    `apply run expression is ${runBody.length} characters; keep margin below GitHub's 21,000-character limit`,
  );
  assert.match(applyStep, /processed-limit "\$close_processed_limit"/);
  assert.match(applyStep, /comment_sync_processed_limit=1000/);
  assert.match(applyStep, /--processed-limit "\$comment_sync_processed_limit"/);
  const applyFlagInit = applyStep.indexOf('explicit_item_numbers="$item_numbers"');
  assert.ok(applyFlagInit > applyStep.indexOf('item_numbers="${{'));
  assert.ok(applyFlagInit < applyStep.indexOf("auto_selected_apply_batch=true"));
  assert.match(applyStep, /apply_cursor_path="results\/apply-cursors\/\$\{target_slug\}\.json"/);
  assert.match(applyHelper, /write_apply_health\(\)/);
  assert.match(applyStep, /proposed-item-count/);
  assert.match(applyStep, /apply-cursor-advance-count/);
  assert.match(applyStep, /examined_count="\$\(apply_checkpoint_examined_count\)"/);
  assert.match(applyHelper, /apply_checkpoint_examined_count\(\)/);
  assert.match(applyHelper, /printf '%s\\n' "unavailable"/);
  assert.match(applyStep, /Candidates examined: \$examined_count\. Action records: \$result_count/);
  assert.match(applyHelper, /--candidate-count "\$health_candidate_count"/);
  assert.match(applyHelper, /--cursor-advance-count "\$health_cursor_advance_count"/);
  assert.match(applyHelper, /--scheduled-interval-minutes "\$health_scheduled_interval_minutes"/);
  assert.match(applyHelper, /pnpm run --silent workflow -- summarize-apply-report/);
  assert.match(applyHelper, /health_cursor_path="\$\{5:-\}"/);
  assert.match(applyStep, /comment_sync_health_cursor_path="\$cursor_path"/);
  assert.match(applyStep, /comment_sync_health_cursor_required="true"/);
  assert.match(applyStep, /comment_sync_health_processed_limit="\$sync_batch_size"/);
  assert.match(applyStep, /close_health_cursor_path="\$apply_cursor_path"/);
  assert.match(applyStep, /--apply-health-file "\.artifacts\/apply-health-\$checkpoint\.json"/);
  assert.match(applyStep, /--apply-health-file "\.artifacts\/apply-health-final\.json"/);
  assert.match(applyStep, /--state "Apply idle"/);
  assert.match(applyHelper, /proposed-item-quality-summary/);
  assert.match(applyHelper, /candidate_quality_summary="\$\(awk -F=/);
  assert.match(
    applyHelper,
    /candidate_quality_detail=" Close candidate mix: \$candidate_quality_summary\."/,
  );
  assert.match(applyStep, /awaiting apply\.\$candidate_quality_detail Scheduled apply/);
  assert.match(
    applyStep,
    /\$apply_close_reasons\.\$candidate_quality_detail Scan window: \$close_processed_limit/,
  );
  const applyReconcileIndex = applyStep.indexOf('pnpm run reconcile -- "${reconcile_args[@]}"');
  const qualitySummaryIndex = applyStep.indexOf("summarize_apply_candidate_quality");
  const proposedNumbersIndex = applyStep.indexOf("proposed-item-numbers");
  assert.notEqual(applyReconcileIndex, -1);
  assert.ok(qualitySummaryIndex > applyReconcileIndex);
  assert.ok(proposedNumbersIndex > qualitySummaryIndex);
  assert.match(applyStep, /--batch-size "\$close_processed_limit"/);
  assert.match(
    applyStep,
    /--close-limit "\$\(\(limit < checkpoint_size \? limit : checkpoint_size\)\)"/,
  );
  assert.match(applyStep, /--coverage-proof-limit "\$coverage_proof_limit"/);
  assert.match(applyStep, /select_bounded_coverage_proof_tail/);
  assert.match(applyHelper, /select_bounded_coverage_proof_tail\(\)/);
  assert.match(applyHelper, /proposed-pr-close-coverage-item-numbers/);
  assert.match(applyHelper, /drop_bounded_coverage_proof_tail\(\)/);
  assert.match(applyStep, /drop_bounded_coverage_proof_tail "\$cursor_trace_path"/);
  assert.match(
    applyStep,
    /Scan window: \$close_processed_limit records \(\$adaptive_apply_scan_reason\)/,
  );
  assert.match(applyStep, /Selected \$proposed_count from \$close_processed_limit/);
  assert.match(applyStep, /--cursor-path "\$apply_cursor_path"/);
  assert.match(applyStep, /write-apply-cursor/);
  assert.match(applyStep, /--item-numbers "\$item_numbers"/);
  assert.match(applyStep, /--coverage-proof-item-numbers "\$coverage_proof_item_numbers"/);
  assert.match(applyStep, /--cursor-trace "\$cursor_trace_path"/);
  assert.match(applyStep, /cursor_trace_arg=\(--cursor-trace "\$cursor_trace_path"\)/);
  assert.match(applyStep, /select_automatic_apply_runtime/);
  assert.match(applyStep, /"\$\{max_runtime_arg\[@\]\}"/);
  assert.match(applyStep, /results\/apply-cursors/);
  assert.match(applyStep, /reached its \$close_processed_limit-record budget/);
  assert.match(applyStep, /next scheduled apply run will advance the next window/);
  assert.match(applyStep, /apply_close_reasons="\$\(printf '%s\\n' "\$apply_close_reasons"/);
  assert.match(applyStep, /No enabled close reasons remain after policy filtering/);
  assert.match(applyStep, /true\|1\|yes\|on\) product_direction_enabled=true/);
  assert.match(applyStep, /if \[ "\$result_count" -ge "\$close_processed_limit" \]; then/);
  assert.match(applyHelper, /--action skipped_runtime_budget/);
  assert.match(applyStep, /if automatic_apply_runtime_reached/);
  assert.match(applyHelper, /runtime budget before cursor progress/);
  assert.match(applyHelper, /fresh-token continuation will resume the lane/);
  assert.doesNotMatch(
    applyStep,
    /if \[ "\$result_count" -ge "\$close_processed_limit" \] && \[ "\$closed_in_chunk" -gt 0 \]/,
  );
  assert.match(applyStep, /sync_comments_only" != "true" .*apply_close_reasons/);
  assert.match(applyStep, /continue_apply=true/);
  assert.match(applyStep, /break\n\s+done/);
  assert.match(applyStep, /next_apply_item_numbers="\$item_numbers"/);
  assert.match(applyStep, /next_apply_item_numbers=""/);
  assert.match(applyStep, /echo "APPLY_CONTINUE=\$continue_apply"/);
  assert.match(applyStep, /echo "APPLY_AUTO_SELECTED_BATCH=\$auto_selected_apply_batch"/);
  assert.match(applyStep, /echo "APPLY_CANDIDATE_QUALITY_SUMMARY=\$candidate_quality_summary"/);
  assert.match(continueStep, /APPLY_CONTINUE:-false/);
  assert.match(continueStep, /can_share_apply_continuation=false/);
  assert.match(continueStep, /\[ "\$\{APPLY_AUTO_SELECTED_BATCH:-false\}" = "true" \]/);
  assert.match(continueStep, /\[ -z "\$\{APPLY_ITEM_NUMBERS:-\}" \]/);
  assert.match(continueStep, /\[ "\$\{APPLY_LIMIT:-20\}" = "20" \]/);
  assert.match(continueStep, /\[ "\$\{APPLY_CHECKPOINT_SIZE:-20\}" = "20" \]/);
  assert.match(continueStep, /\[ "\$\{APPLY_COMMENT_SYNC_MIN_AGE_DAYS:-7\}" = "7" \]/);
  assert.match(continueStep, /preserving exact continuation dispatch/);
  assert.match(
    continueStep,
    /gh api --paginate "repos\/\$\{\{ github\.repository \}\}\/actions\/runs\?per_page=100&status=\$\{run_status\}"/,
  );
  assert.match(continueStep, /workflowPath:\.path/);
  assert.doesNotMatch(continueStep, /workflowName:\.name/);
  assert.doesNotMatch(continueStep, /gh run list/);
  assert.match(continueStep, /pnpm run --silent workflow -- apply-continuation-blocker/);
  assert.match(continueStep, /--current-run-id "\$\{\{ github\.run_id \}\}"/);
  assert.match(continueStep, /--target-repo "\$\{APPLY_TARGET_REPO:-openclaw\/openclaw\}"/);
  assert.match(continueStep, /APPLY_CONTINUATION_BLOCKED/);
  assert.match(continueStep, /existing default cursor run will continue the lane/);
  assert.match(continueStep, /already covered by \$/);
  assert.match(continueStep, /-f apply_item_numbers="\$APPLY_ITEM_NUMBERS"/);
  assert.doesNotMatch(continueStep, /APPLY_CLOSED_TOTAL:-0.*APPLY_LIMIT:-0/);
});

test("apply workflow does not queue runtime-yield continuation without cursor progress", () => {
  const root = mkdtempSync(tmpPrefix);
  const reportPath = join(root, "apply-report.json");
  writeFileSync(reportPath, JSON.stringify([{ number: 0, action: "skipped_runtime_budget" }]));

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          "pnpm() { printf '1\\n'; }",
          "source scripts/apply-workflow-helpers.sh",
          "continue_apply=false",
          "auto_selected_apply_batch=true",
          "cursor_advance_count=0",
          'if automatic_apply_runtime_reached "$REPORT_PATH"; then status=yielded; else status=no_yield; fi',
          'printf \'%s|%s\\n\' "$status" "$continue_apply"',
          "continue_apply=false",
          "cursor_advance_count=1",
          'if automatic_apply_runtime_reached "$REPORT_PATH"; then status=yielded; else status=no_yield; fi',
          'printf \'%s|%s\\n\' "$status" "$continue_apply"',
        ].join("\n"),
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          REPORT_PATH: reportPath,
        },
      },
    );

    assert.deepEqual(
      output
        .trim()
        .split("\n")
        .filter((line) => line.includes("|")),
      ["yielded|false", "yielded|true"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply workflow drops a coverage-proof tail only after exact trace examination", () => {
  const root = mkdtempSync(tmpPrefix);
  const fastOnlyTrace = join(root, "fast-only.json");
  const proofTrace = join(root, "proof.json");
  writeFileSync(
    fastOnlyTrace,
    JSON.stringify({ schema_version: 1, examined_item_numbers: [10, 20] }),
  );
  writeFileSync(proofTrace, JSON.stringify({ schema_version: 1, examined_item_numbers: [30] }));

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          "source scripts/apply-workflow-helpers.sh",
          "auto_selected_apply_batch=true",
          "item_numbers=10,20,30",
          "coverage_proof_item_numbers=30",
          'item_numbers_arg=(--item-numbers "$item_numbers")',
          'drop_bounded_coverage_proof_tail "$FAST_ONLY_TRACE"',
          'printf \'%s|%s|%s\\n\' "$item_numbers" "$coverage_proof_item_numbers" "${item_numbers_arg[*]}"',
          'drop_bounded_coverage_proof_tail "$PROOF_TRACE"',
          'printf \'%s|%s|%s\\n\' "$item_numbers" "$coverage_proof_item_numbers" "${item_numbers_arg[*]}"',
        ].join("\n"),
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, FAST_ONLY_TRACE: fastOnlyTrace, PROOF_TRACE: proofTrace },
      },
    );
    assert.deepEqual(output.trim().split("\n"), [
      "10,20,30|30|--item-numbers 10,20,30",
      "10,20||--item-numbers 10,20",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply workflow syncs source checkout before state hydration", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const applyJobStart = workflow.indexOf("\n  apply-existing:");
  assert.notEqual(applyJobStart, -1);
  const applyJob = workflow.slice(applyJobStart);
  const resolveTargetStart = applyJob.indexOf("- name: Resolve target repository");
  const syncStart = applyJob.indexOf("- name: Sync source checkout before state hydration");
  const setupStateStart = applyJob.indexOf("- uses: ./.github/actions/setup-state");
  const reconcileStart = applyJob.indexOf("- name: Reconcile before apply preselect");

  assert.ok(resolveTargetStart !== -1);
  assert.ok(syncStart > resolveTargetStart);
  assert.ok(setupStateStart > syncStart);
  assert.ok(reconcileStart > setupStateStart);
  assert.equal(applyJob.indexOf("- name: Sync before applying decisions"), -1);
  assert.match(applyJob.slice(syncStart, setupStateStart), /run: git pull --rebase/);
  assert.doesNotMatch(applyJob.slice(setupStateStart, reconcileStart), /git pull --rebase/);
});

test("sweep target tokens fall back when an org app installation is missing", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const stepBlocks = (name: string) =>
    workflow
      .split(`- name: ${name}`)
      .slice(1)
      .map((block) => block.split("\n      - ")[0]);

  assert.match(
    workflow,
    /CLAWSWEEPER_INVENTORY_TOKEN_STEIPETE: \$\{\{ steps\.steipete-token\.outputs\.token \|\| '__public__' \}\}/,
  );
  const openclawInventoryBlocks = stepBlocks("Create OpenClaw inventory token");
  assert.equal(openclawInventoryBlocks.length, 1);
  assert.doesNotMatch(openclawInventoryBlocks[0] ?? "", /continue-on-error: true/);
  for (const name of [
    "Create target read token",
    "Create target write token",
    "Create target review token",
    "Create target Codex inspection token",
  ]) {
    const blocks = stepBlocks(name);
    assert.ok(blocks.length > 0, `missing workflow step: ${name}`);
    for (const block of blocks) {
      assert.match(block, /continue-on-error: true/);
    }
  }
  assert.match(
    workflow,
    /GH_TOKEN: \$\{\{ steps\.target-read-token\.outputs\.token \|\| github\.token \}\}/,
  );
  assert.match(
    workflow,
    /CLAWSWEEPER_PROOF_INSPECTION_TOKEN: \$\{\{ steps\.codex-inspection-token\.outputs\.token \|\| github\.token \}\}/,
  );
  assert.ok(
    workflow.includes(
      "if: ${{ success() && steps.target-write-token.outputs.token != '' && needs.plan.outputs.hot_intake != 'true'",
    ),
  );
  assert.ok(
    workflow.includes(
      "if: ${{ success() && steps.target-write-token.outputs.token != '' && ((github.event_name == 'repository_dispatch'",
    ),
  );
  assert.ok(
    workflow.includes(
      "if: ${{ success() && steps.target-write-token.outputs.token != '' && github.event.inputs.apply_after_review == 'true' }}",
    ),
  );
  assert.doesNotMatch(workflow, new RegExp("OPENCLAW_" + "GH_TOKEN"));
});

test("proof nudge workflow is manual-first and scheduled behind repo vars", () => {
  const sweepWorkflow = readText(".github/workflows/sweep.yml");
  const workflow = readText(".github/workflows/proof-nudges.yml");
  const job = workflow.slice(workflow.indexOf("  proof-nudges:"), workflow.length);
  const concurrency = workflow.slice(workflow.indexOf("concurrency:"), workflow.indexOf("\njobs:"));

  assert.doesNotMatch(sweepWorkflow, /proof_nudges/);
  assert.match(workflow, /execute:[\s\S]*?default: "false"/);
  assert.match(workflow, /cron: "0 10 \* \* \*"/);
  assert.doesNotMatch(workflow, /cron: "0 11 \* \* \*"/);
  assert.match(concurrency, /clawsweeper-proof-nudges/);
  assert.doesNotMatch(job, /Check scheduled Central time/);
  assert.doesNotMatch(job, /PROOF_NUDGES_SCHEDULE_TZ/);
  assert.doesNotMatch(job, /PROOF_NUDGES_EVENT_SCHEDULE/);
  assert.doesNotMatch(job, /steps\.central-time\.outputs\.should_run == 'true'/);
  assert.match(job, /github\.event_name == 'workflow_dispatch'/);
  assert.match(job, /vars\.CLAWSWEEPER_PROOF_NUDGES_SCHEDULED == '1'/);
  assert.match(job, /vars\.CLAWSWEEPER_BOT_PROOF_SCHEDULED == '1'/);
  assert.match(job, /vars\.CLAWSWEEPER_PROOF_NUDGES_EXECUTE == '1'/);
  assert.match(job, /vars\.CLAWSWEEPER_BOT_PROOF_EXECUTE == '1'/);
  assert.match(
    job,
    /github\.event_name == 'schedule' && \(vars\.CLAWSWEEPER_PROOF_NUDGES_SCHEDULED == '1' \|\| vars\.CLAWSWEEPER_BOT_PROOF_SCHEDULED == '1'\)/,
  );
  assert.match(job, /TARGET_REPO_INPUT:/);
  assert.match(job, /target_repo must be owner\/repo/);
  assert.match(job, /PROOF_NUDGES_ITEM_NUMBERS:/);
  assert.match(job, /item_numbers must be a comma-separated list/);
  assert.match(job, /PROOF_NUDGES_LIMIT:/);
  assert.match(job, /PROOF_NUDGES_PROCESSED_LIMIT:/);
  assert.match(job, /PROOF_NUDGES_PROCESSED_LIMIT must be a positive integer/);
  assert.match(job, /PROOF_NUDGES_MIN_AGE_DAYS:/);
  assert.match(job, /PROOF_NUDGES_COOLDOWN_DAYS:/);
  assert.match(job, /permission-pull-requests: write/);
  assert.match(
    job,
    /numeric_input in PROOF_NUDGES_LIMIT PROOF_NUDGES_MIN_AGE_DAYS PROOF_NUDGES_COOLDOWN_DAYS/,
  );
  assert.match(job, /execute_arg=\(\)/);
  assert.match(job, /if \[ "\$PROOF_NUDGES_EXECUTE" = "true" \]/);
  assert.match(job, /processed_limit_arg=\(\)/);
  assert.match(job, /--processed-limit "\$PROOF_NUDGES_PROCESSED_LIMIT"/);
  assert.match(job, /--cursor-path "results\/proof-nudge-cursors\/\$\{target_slug\}\.json"/);
  assert.match(job, /--cursor-path "results\/bot-proof-cursors\/\$\{target_slug\}\.json"/);
  assert.match(job, /pnpm run proof-nudges/);
  assert.match(job, /vars\.CLAWSWEEPER_PROOF_NUDGES_LIMIT/);
  assert.match(job, /vars\.CLAWSWEEPER_PROOF_NUDGES_PROCESSED_LIMIT/);
  assert.match(job, /repair:publish-main/);
  assert.match(job, /results\/proof-nudge-cursors/);
  assert.match(job, /results\/bot-proof-cursors/);
});

test("proof nudge workflow publishes exact cursor files only for executed lanes", () => {
  const workflow = readFileSync(".github/workflows/proof-nudges.yml", "utf8");
  const job = workflow.slice(workflow.indexOf("  proof-nudges:"), workflow.length);
  assert.match(job, /proof_cursor_path="results\/proof-nudge-cursors\/\$\{target_slug\}\.json"/);
  assert.match(job, /bot_cursor_path="results\/bot-proof-cursors\/\$\{target_slug\}\.json"/);
  assert.match(job, /if \[ "\$PROOF_NUDGES_EXECUTE" = "true" \] && \[ -f "\$proof_cursor_path" \]/);
  assert.match(job, /if \[ "\$BOT_PROOF_EXECUTE" = "true" \] && \[ -f "\$bot_cursor_path" \]/);
  assert.match(job, /cursor_publish_args\+=\(--path "\$(?:proof|bot)_cursor_path"\)/);
  assert.doesNotMatch(
    job,
    /cursor_publish_args\+=\(--path results\/(?:proof-nudge|bot-proof)-cursors\)/,
  );
});

test(
  "read-only checkout mode restores file modes and leaves git metadata writable",
  {
    skip:
      process.platform === "win32" ? "exact POSIX mode bits are not portable on Windows" : false,
  },
  () => {
    const root = mkdtempSync(tmpPrefix);
    try {
      const target = join(root, "target");
      const nested = join(target, "src");
      const gitDir = join(target, ".git");
      mkdirSync(nested, { recursive: true });
      mkdirSync(gitDir, { recursive: true });
      const sourceFile = join(nested, "app.ts");
      const executableFile = join(target, "tool.sh");
      const gitConfig = join(gitDir, "config");
      writeFileSync(sourceFile, "export const value = 1;\n");
      writeFileSync(executableFile, "#!/bin/sh\n");
      writeFileSync(gitConfig, "[core]\n");
      chmodSync(target, 0o755);
      chmodSync(nested, 0o750);
      chmodSync(sourceFile, 0o640);
      chmodSync(executableFile, 0o755);
      chmodSync(gitDir, 0o700);
      chmodSync(gitConfig, 0o600);

      const snapshots = makeTreeReadOnlyForTest(target);
      assert.equal(statSync(target).mode & 0o777, 0o555);
      assert.equal(statSync(nested).mode & 0o777, 0o555);
      assert.equal(statSync(sourceFile).mode & 0o777, 0o444);
      assert.equal(statSync(executableFile).mode & 0o777, 0o555);
      assert.equal(statSync(gitDir).mode & 0o777, 0o700);
      assert.equal(statSync(gitConfig).mode & 0o777, 0o600);

      restoreTreeModesForTest(snapshots);
      assert.equal(statSync(target).mode & 0o777, 0o755);
      assert.equal(statSync(nested).mode & 0o777, 0o750);
      assert.equal(statSync(sourceFile).mode & 0o777, 0o640);
      assert.equal(statSync(executableFile).mode & 0o777, 0o755);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("event review completion removes ClawSweeper eyes reaction", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const block = workflow.slice(
    workflow.indexOf("- name: React to target item completion"),
    workflow.indexOf("\n\n  plan:"),
  );

  assert.match(block, /-f content="\+1"/);
  assert.match(block, /-f content="eyes"/);
  assert.match(block, /repos\/\$TARGET_REPO\/issues\/\$ITEM_NUMBER\/reactions\/\$reaction_id/);
  assert.match(block, /"openclaw-clawsweeper\[bot\]"/);
  assert.doesNotMatch(block, /issues\/comments\/\$ITEM_NUMBER\/reactions/);
});

test("event re-review status lets the durable queue reconcile interruptions", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const block = workflow.slice(
    workflow.indexOf("- name: Mark re-review complete"),
    workflow.indexOf("- name: Commit event comment router ledger"),
  );

  assert.match(block, /\[ "\$REVIEW_OUTCOME" = "cancelled" \]/);
  assert.match(block, /state="Interrupted"/);
  assert.match(block, /The exact-review queue will reconcile a newer pending item if one arrived/);
  assert.doesNotMatch(block, /CAPACITY_OUTCOME/);
  assert.doesNotMatch(block, /state="Superseded"/);
});

test("event repair retries wait for active worker capacity", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const block = workflow.slice(
    workflow.indexOf("- name: Detect waiting event repair dispatches"),
    workflow.indexOf("- name: Commit event comment router retry ledger"),
  );

  assert.match(block, /--status waiting,active/);
  assert.match(block, /--wait-for-capacity/);
});

test("comment commands keep the router-to-sweep dispatch contract", () => {
  const routerWorkflow = readText(".github/workflows/repair-comment-router.yml");
  const sweepWorkflow = readText(".github/workflows/sweep.yml");
  const routerSource = readText("src/repair/comment-router.ts");

  assert.match(routerWorkflow, /types:\s*\[clawsweeper_comment\]/);
  assert.match(routerWorkflow, /pnpm run repair:comment-router/);
  assert.match(
    routerWorkflow,
    /status_comment_id="\$\{\{ github\.event\.client_payload\.status_comment_id \|\| '' \}\}"/,
  );
  assert.match(routerWorkflow, /--status-comment-id "\$status_comment_id"/);
  assert.match(routerSource, /event_type:\s*"clawsweeper_item"/);
  assert.match(routerSource, /adaptiveReviewBudgetForPullRequest\(command\.target\)/);
  assert.match(routerSource, /media_proof_timeout_ms: reviewBudget\.mediaProofTimeoutMs/);
  assert.match(routerSource, /dispatch_key:\s*dispatchKey/);
  assert.match(routerSource, /`item_numbers=\$\{dispatchKey\}`/);
  assert.match(routerSource, /event:\s*"workflow_dispatch"/);
  assert.match(sweepWorkflow, /types:\s*\[clawsweeper_item,\s*clawsweeper_target_sweep\]/);
  assert.match(sweepWorkflow, /Review event item \{0\}#\{1\} \[\{2\}\]/);
  assert.match(sweepWorkflow, /startsWith\(github\.event\.inputs\.item_numbers, 'router-'\)/);
  assert.doesNotMatch(sweepWorkflow, /types:\s*\[[^\]]*clawsweeper_comment/);
});

test("comment router prunes bare ack comments after updating shared automerge status", () => {
  const routerSource = readText("src/repair/comment-router.ts");
  const postComment = routerSource.slice(
    routerSource.indexOf("function postComment("),
    routerSource.indexOf("\nfunction findExistingCommandStatusComment"),
  );

  assert.match(postComment, /const existingStatus = findExistingCommandStatusComment\(command\);/);
  assert.match(postComment, /const precreated = findPrecreatedCommandStatusComment\(command\);/);
  assert.match(postComment, /const existing = existingStatus \?\? precreated;/);
  assert.match(
    postComment,
    /if \(existingStatus && precreatedId > 0 && precreatedId !== existingId\)/,
  );
  assert.match(postComment, /issues\/comments\/\$\{precreatedId\}/);
  assert.match(postComment, /"DELETE"/);
  assert.match(postComment, /pruned_ack_comment_id: String\(precreatedId\)/);
});

test("manual exact-item review dispatches avoid broad review concurrency", () => {
  const workflow = readText(".github/workflows/sweep.yml");

  assert.match(
    workflow,
    /github\.event_name == 'workflow_dispatch' && \(github\.event\.inputs\.item_number != '' \|\| github\.event\.inputs\.item_numbers != ''\)\) && format\('clawsweeper-intake-exact-\{0\}'/,
  );
  assert.doesNotMatch(
    workflow,
    /github\.event_name == 'workflow_dispatch' && github\.event\.inputs\.hot_intake == 'true' && \(github\.event\.inputs\.item_number != '' \|\| github\.event\.inputs\.item_numbers != ''\)\) && format\('clawsweeper-intake-exact-\{0\}'/,
  );
});

test("sweep workflow publishes target-scoped state paths", () => {
  const workflow = readText(".github/workflows/sweep.yml");

  assert.match(workflow, /target_slug="\$TARGET_REPO"/);
  assert.match(workflow, /--path "records\/\$\{target_slug\}"/);
  assert.match(workflow, /--path "results\/sweep-status\/\$\{target_slug\}\.json"/);
  assert.doesNotMatch(workflow, /--path records\s*\\/);
  assert.doesNotMatch(workflow, /--path results\/sweep-status\s*\\/);
});

test("sweep workflow schedules cursor-based PR comment sync batches", () => {
  const workflow = readText(".github/workflows/sweep.yml");

  assert.match(workflow, /cron: "6,21,36,51 \* \* \* \*"/);
  assert.doesNotMatch(workflow, /apply_sync_open_pr_batch:/);
  assert.match(
    workflow,
    /sync_batch_size="\$\{\{ github\.event_name == 'workflow_dispatch' && github\.event\.inputs\.apply_limit \|\| '25' \}\}"/,
  );
  assert.match(workflow, /\$item_numbers" = "__cursor__"/);
  assert.match(workflow, /comment-sync-batch/);
  assert.match(workflow, /write-comment-sync-cursor/);
  assert.match(workflow, /results\/comment-sync-cursors\/\$\{target_slug\}\.json/);
  assert.match(workflow, /APPLY_SYNC_OPEN_PR_BATCH/);
  assert.match(workflow, /github\.event\.schedule == '6,21,36,51 \* \* \* \*'/);
});

test("sweep target checkouts retry without cached references", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const checkoutBlocks =
    workflow.match(/- name: Check out target repository[\s\S]*?rev-parse --short HEAD/g) ?? [];

  assert.equal(checkoutBlocks.length, 2);
  for (const block of checkoutBlocks) {
    assert.match(block, /Cached target repository fetch failed; rebuilding cache/);
    assert.match(block, /Cached target checkout failed; retrying without cache reference/);
    assert.match(block, /rm -rf "\$checkout_dir" "\$cache_dir"/);
    assert.match(
      block,
      /git clone --filter=blob:none --branch "\$target_branch" --single-branch "\$url" "\$checkout_dir"/,
    );
  }
});

test("target sweep runs count as background review capacity", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const capacityBlock = workflow.slice(
    workflow.indexOf("active_sweep_background_workers()"),
    workflow.indexOf(
      'active_critical_workers="$',
      workflow.indexOf("active_sweep_background_workers()"),
    ),
  );

  assert.match(workflow, /Review hot target repo/);
  assert.match(capacityBlock, /startswith\("Review target repo "\)/);
  assert.match(capacityBlock, /startswith\("Review hot target repo "\)/);
  assert.match(capacityBlock, /Review\\ hot\\ target\\ repo/);
});

test("target hot sweep dispatches honor shard cap payload", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const modeBlock = workflow.slice(
    workflow.indexOf("- id: mode"),
    workflow.indexOf("\n      - id: select"),
  );

  assert.match(modeBlock, /elif \[ "\$hot_intake" = "true" \]; then/);
  assert.match(
    modeBlock,
    /shard_count="\$\{\{ github\.event\.client_payload\.shard_count \|\| '' \}\}"/,
  );
  assert.match(modeBlock, /shard_count="\$hot_intake_shards"/);
});

test("review git info follows checked-out target branch", () => {
  const source = readText("src/clawsweeper.ts");

  assert.match(source, /function reviewTargetBranch/);
  assert.match(source, /rev-parse", "--abbrev-ref", "HEAD"/);
  assert.match(source, /refs\/remotes\/origin\/\$\{targetBranch\}/);
});

test("sweep workflow_dispatch input count stays under GitHub limit", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const inputBlock = workflow.slice(
    workflow.indexOf("  workflow_dispatch:\n    inputs:"),
    workflow.indexOf("\n  schedule:"),
  );
  const inputNames = [...inputBlock.matchAll(/^      [A-Za-z0-9_]+:/gm)];

  assert.ok(inputNames.length <= 25, `workflow_dispatch has ${inputNames.length} inputs`);
});

test("sweep review continuations stay workflow-dispatch compatible", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const continueBlock = workflow.slice(
    workflow.indexOf("- name: Continue sweep"),
    workflow.indexOf("\n\n  recover-review-failures:"),
  );
  const recoveryBlock = workflow.slice(
    workflow.indexOf("args=(\n            workflow run sweep.yml"),
    workflow.indexOf("\n\n  audit-dashboard:"),
  );

  for (const block of [continueBlock, recoveryBlock]) {
    assert.match(block, /-f target_repo="\$\{\{ needs\.plan\.outputs\.target_repo \}\}"/);
    assert.match(block, /-f target_branch="\$\{\{ needs\.plan\.outputs\.target_branch \}\}"/);
  }
});

test("target sweep dispatches preserve disabled ClawHub guard", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const planHeader = workflow.slice(
    workflow.indexOf("\n  plan:"),
    workflow.indexOf("\n    runs-on:", workflow.indexOf("\n  plan:")),
  );

  assert.match(planHeader, /github\.event\.action == 'clawsweeper_target_sweep'/);
  assert.match(
    planHeader,
    /github\.event_name == 'repository_dispatch' && github\.event\.client_payload\.target_repo == 'openclaw\/clawhub' && vars\.CLAWSWEEPER_ENABLE_CLAWHUB != '1'/,
  );
});

test("sweep planning-started status publish is bounded", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const block = workflow.slice(
    workflow.indexOf("- name: Publish planning-started status"),
    workflow.indexOf("- id: mode"),
  );

  assert.match(block, /timeout 20s pnpm run repair:publish-main/);
  assert.match(block, /Skipped slow planning-started dashboard publish/);
});

test("review capacity probes use REST actions run listing", () => {
  const sweepWorkflow = readText(".github/workflows/sweep.yml");
  const sweepBlock = sweepWorkflow.slice(
    sweepWorkflow.indexOf("- id: mode"),
    sweepWorkflow.indexOf("- id: select"),
  );
  const commitWorkflow = readText(".github/workflows/commit-review.yml");
  const commitBlock = commitWorkflow.slice(
    commitWorkflow.indexOf("- name: Select commits"),
    commitWorkflow.indexOf('if [ "$ENABLED" = "false" ]'),
  );

  for (const block of [sweepBlock, commitBlock]) {
    assert.match(block, /active_runs_json\(\)/);
    assert.match(block, /actions\/runs\?per_page=100/);
    assert.match(block, /--paginate/);
    assert.match(block, /status=\$\{run_status\}/);
    assert.match(block, /workflowPath:\.path/);
    assert.doesNotMatch(block, /workflowName:\.name/);
    assert.match(block, /displayTitle:\.display_title/);
    assert.match(block, /createdAt:\.created_at/);
    assert.match(block, /updatedAt:\.updated_at/);
    assert.match(block, /STALE_QUEUED_CUTOFF/);
    assert.doesNotMatch(block, /gh run list/);
    assert.match(block, /gh run view/);
  }
});

test("background review capacity reserves expanding matrices and caps broad manual input", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const modeBlock = workflow.slice(
    workflow.indexOf("- id: mode"),
    workflow.indexOf("- id: select"),
  );
  const commitWorkflow = readText(".github/workflows/commit-review.yml");
  const commitBlock = commitWorkflow.slice(
    commitWorkflow.indexOf("- name: Select commits"),
    commitWorkflow.indexOf('if [ "$ENABLED" = "false" ]'),
  );

  assert.match(modeBlock, /limit review_shards\.hot_intake_default/);
  assert.match(modeBlock, /limit review_shards\.normal_default/);
  assert.match(modeBlock, /STALE_QUEUED_CUTOFF/);
  assert.match(modeBlock, /updatedAt:\.updated_at/);
  assert.match(modeBlock, /workflowPath == "\.github\/workflows\/sweep\.yml"/);
  assert.match(modeBlock, /WORKFLOW_PATH="\$1"/);
  assert.doesNotMatch(modeBlock, /workflowName == "ClawSweeper"/);
  assert.doesNotMatch(modeBlock, /WORKFLOW_NAME="\$1"/);
  assert.match(modeBlock, /total_shards/);
  assert.match(modeBlock, /completed shard jobs are publishing and consume no/);
  assert.match(modeBlock, /\[ "\$active_shards" -lt 1 \] && \[ "\$total_shards" -lt 1 \]/);
  assert.match(modeBlock, /lane_shard_cap="\$normal_shards"/);
  assert.match(modeBlock, /lane_shard_cap="\$hot_intake_shards"/);
  assert.match(modeBlock, /Capping broad background review shards/);
  assert.match(commitBlock, /limit review_shards\.hot_intake_default/);
  assert.match(commitBlock, /limit review_shards\.normal_default/);
  assert.match(commitBlock, /STALE_QUEUED_CUTOFF/);
  assert.match(commitBlock, /updatedAt:\.updated_at/);
  assert.match(commitBlock, /workflowPath == "\.github\/workflows\/sweep\.yml"/);
  assert.match(commitBlock, /WORKFLOW_PATH="\$1"/);
  assert.doesNotMatch(commitBlock, /workflowName == "ClawSweeper"/);
  assert.doesNotMatch(commitBlock, /WORKFLOW_NAME="\$1"/);
});

test("review backstops identify sweep runs by stable workflow path", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const block = workflow.slice(workflow.indexOf("- name: Queue review backstops"));

  assert.match(block, /actions\/runs\?per_page=100/);
  assert.match(block, /workflowPath:\.path/);
  assert.match(block, /run\.workflowPath !== "\.github\/workflows\/sweep\.yml"/);
  assert.doesNotMatch(block, /gh run list/);
  assert.doesNotMatch(block, /run\.workflowName/);
});

test("scheduled background reviews serialize planners and refill released capacity", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const concurrencyBlock = workflow.slice(
    workflow.indexOf("concurrency:"),
    workflow.indexOf("jobs:"),
  );
  const planHeader = workflow.slice(
    workflow.indexOf("\n  plan:"),
    workflow.indexOf("\n    outputs:", workflow.indexOf("\n  plan:")),
  );

  assert.match(concurrencyBlock, /format\('clawsweeper-intake-v2-\{0\}', github\.run_id\)/);
  assert.match(concurrencyBlock, /format\('clawsweeper-review-\{0\}', github\.run_id\)/);
  assert.match(planHeader, /group: \$\{\{ format\('clawsweeper-planner-\{0\}'/);
  assert.match(planHeader, /\|\| github\.run_id/);
  assert.match(planHeader, /cancel-in-progress: false/);
});

test("scheduled normal review keeps workers warm with multi-item shards", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const modeBlock = workflow.slice(
    workflow.indexOf("- id: mode"),
    workflow.indexOf("- id: select"),
  );

  assert.match(
    modeBlock,
    /if \[ "\$\{\{ github\.event_name \}\}" = "schedule" \]; then\s+batch_size="3"/,
  );
});

test("planned background reviews allow safe content-cache reuse without weakening exact reviews", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const eventReviewJobStart = workflow.indexOf("\n  event-review-apply:");
  const planJobStart = workflow.indexOf("\n  plan:", eventReviewJobStart);
  const eventReviewJob = workflow.slice(eventReviewJobStart, planJobStart);
  const reviewJobStart = workflow.indexOf("\n  review:");
  const publishJobStart = workflow.indexOf("\n  publish:", reviewJobStart);
  const reviewJob = workflow.slice(reviewJobStart, publishJobStart);

  assert.match(
    reviewJob,
    /EXACT_ITEM: \$\{\{ github\.event\.client_payload\.item_number \|\| github\.event\.inputs\.item_number \|\| github\.event\.inputs\.item_numbers \|\| '' \}\}/,
  );
  assert.match(reviewJob, /if \[ -z "\$EXACT_ITEM" \]; then/);
  assert.match(reviewJob, /planned_automatic_review_arg=\(--planned-automatic-review\)/);
  assert.match(
    reviewJob,
    /--item-numbers "\$\{\{ matrix\.item_numbers \}\}" \\\n+\s+"\$\{planned_automatic_review_arg\[@\]\}"/,
  );
  assert.doesNotMatch(eventReviewJob, /--planned-automatic-review/);
});

test("sweep event reviews and target fanout avoid storm amplification", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const legacyIntakeBlock = workflow.slice(
    workflow.indexOf("legacy-event-queue-intake:"),
    workflow.indexOf("event-review-apply:"),
  );
  const eventBlock = workflow.slice(
    workflow.indexOf("event-review-apply:"),
    workflow.indexOf("target-fanout:"),
  );
  const fanoutBlock = workflow.slice(workflow.indexOf("target-fanout:"), workflow.indexOf("plan:"));

  assert.match(eventBlock, /concurrency:/);
  assert.match(
    eventBlock,
    /clawsweeper-event-review-\$\{\{ github\.event\.client_payload\.target_repo/,
  );
  assert.match(
    eventBlock,
    /group: clawsweeper-event-review-\$\{\{ github\.event\.client_payload\.target_repo \|\| 'openclaw\/openclaw' \}\}-\$\{\{ github\.event\.client_payload\.item_number/,
  );
  assert.match(eventBlock, /queue_lease_id != ''/);
  assert.match(eventBlock, /cancel-in-progress: false/);
  assert.match(legacyIntakeBlock, /legacy-event-queue-intake:/);
  assert.match(legacyIntakeBlock, /\/internal\/exact-review\/enqueue/);
  assert.match(
    fanoutBlock,
    /FANOUT_LIMIT: \$\{\{ github\.event\.schedule == '41 \* \* \* \*' && '6' \|\| \(github\.event\.schedule == '37 \*\/6 \* \* \*' && '12' \|\| '6'\) \}\}/,
  );
});

test("setup-state defaults to an auth-safe shallow checkout", () => {
  const action = readText(".github/actions/setup-state/action.yml");
  const filterBlock = action.slice(action.indexOf("filter:"), action.indexOf("fetch-depth:"));
  const fetchDepthBlock = action.slice(action.indexOf("fetch-depth:"), action.indexOf("runs:"));

  assert.match(filterBlock, /default: ""/);
  assert.doesNotMatch(filterBlock, /default: blob:none/);
  assert.match(action, /filter: \$\{\{ inputs\.filter \}\}/);
  assert.match(fetchDepthBlock, /default: "1"/);
  assert.doesNotMatch(fetchDepthBlock, /default: "0"/);
  assert.match(action, /fetch-depth: \$\{\{ inputs\.fetch-depth \}\}/);
  assert.match(action, /sparse-checkout: \$\{\{ inputs\.sparse-checkout \}\}/);
  assert.doesNotMatch(action, /state-repository:/);
  assert.doesNotMatch(action, /state-ref:/);
  assert.match(action, /repository: openclaw\/clawsweeper-state/);
  assert.match(action, /ref: state/);
});

test("sweep exact event reviews consume adaptive Codex timeout payload", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const resolveBlock = workflow.slice(
    workflow.indexOf("- name: Resolve event payload"),
    workflow.indexOf("- name: Create target read token"),
  );
  const reviewBlock = workflow.slice(
    workflow.indexOf("- name: Review exact event item"),
    workflow.indexOf("- name: Create state token"),
  );

  assert.match(
    resolveBlock,
    /ADAPTIVE_CODEX_TIMEOUT_MS: \$\{\{ github\.event\.client_payload\.codex_timeout_ms \|\| '' \}\}/,
  );
  assert.match(
    resolveBlock,
    /CONFIGURED_CODEX_TIMEOUT_MS: \$\{\{ vars\.CLAWSWEEPER_CODEX_TIMEOUT_MS \|\| '1200000' \}\}/,
  );
  assert.match(
    resolveBlock,
    /MEDIA_PROOF_TIMEOUT_MS: \$\{\{ github\.event\.client_payload\.media_proof_timeout_ms \|\| '0' \}\}/,
  );
  assert.match(resolveBlock, /Ignoring invalid adaptive codex_timeout_ms payload/);
  assert.match(
    resolveBlock,
    /configured_codex_timeout_ms="\$\(\(10#\$configured_codex_timeout_ms\)\)"/,
  );
  assert.match(
    resolveBlock,
    /adaptive_codex_timeout_ms="\$\(\(10#\$adaptive_codex_timeout_ms\)\)"/,
  );
  assert.match(resolveBlock, /media_proof_timeout_ms="\$\(\(10#\$media_proof_timeout_ms\)\)"/);
  assert.match(resolveBlock, /\[ "\$media_proof_timeout_ms" -gt 480000 \]/);
  assert.match(resolveBlock, /\[ "\$adaptive_codex_timeout_ms" -lt 600000 \]/);
  assert.match(resolveBlock, /\[ "\$adaptive_codex_timeout_ms" -gt 1800000 \]/);
  assert.match(resolveBlock, /\[ "\$adaptive_codex_timeout_ms" -gt "\$codex_timeout_ms" \]/);
  assert.match(resolveBlock, /echo "codex_timeout_ms=\$codex_timeout_ms"/);
  assert.match(resolveBlock, /echo "media_proof_timeout_ms=\$media_proof_timeout_ms"/);
  assert.match(
    reviewBlock,
    /codex_timeout_ms="\$\{\{ steps\.target\.outputs\.codex_timeout_ms \}\}"/,
  );
  assert.match(reviewBlock, /media_preprocessing_reserve_seconds=480/);
  assert.match(
    reviewBlock,
    /review_timeout_seconds=\$\(\(codex_timeout_seconds \+ media_preprocessing_reserve_seconds \+ 180\)\)/,
  );
  assert.match(reviewBlock, /detected media allowance \$\{media_proof_timeout_seconds\}s/);
  assert.doesNotMatch(reviewBlock, /review_timeout_seconds=.*media_proof_timeout_seconds/);
  assert.match(reviewBlock, /timeout --kill-after=30s "\$\{review_timeout_seconds\}s"/);
  assert.match(reviewBlock, /--codex-timeout-ms "\$codex_timeout_ms"/);
  assert.doesNotMatch(reviewBlock, /timeout --kill-after=30s 12m/);
  assert.doesNotMatch(reviewBlock, /--codex-timeout-ms 600000/);
});

test("sweep exact event reviews preserve the configured fallback without an adaptive payload", () => {
  const workflow = readText(".github/workflows/sweep.yml");
  const resolveBlock = workflow.slice(
    workflow.indexOf("- name: Resolve event payload"),
    workflow.indexOf("- name: Create target read token"),
  );

  assert.match(
    resolveBlock,
    /CONFIGURED_CODEX_TIMEOUT_MS: \$\{\{ vars\.CLAWSWEEPER_CODEX_TIMEOUT_MS \|\| '1200000' \}\}/,
  );
  assert.match(resolveBlock, /codex_timeout_ms="\$configured_codex_timeout_ms"/);
  assert.match(resolveBlock, /\[ "\$adaptive_codex_timeout_ms" -gt "\$codex_timeout_ms" \]/);
});

test("github activity workflow scopes cancellation to matching item activity", () => {
  const workflow = readText(".github/workflows/github-activity.yml");
  const concurrencyBlock = workflow.slice(
    workflow.indexOf("concurrency:"),
    workflow.indexOf("jobs:"),
  );

  assert.match(concurrencyBlock, /group: >-/);
  assert.match(
    concurrencyBlock,
    /github-activity-\$\{\{ github\.event\.client_payload\.activity\.repo/,
  );
  assert.match(concurrencyBlock, /github\.event\.client_payload\.target_repo/);
  assert.match(concurrencyBlock, /github\.event\.repository\.full_name/);
  assert.match(concurrencyBlock, /github\.event_name == 'workflow_run'/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.event_name/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.activity\.type/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.activity\.action/);
  assert.match(concurrencyBlock, /github\.event\.action/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.comment_id/);
  assert.match(concurrencyBlock, /github\.event\.comment\.id/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.activity\.review\.id/);
  assert.match(concurrencyBlock, /github\.event\.review\.id/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.activity\.pull_request\.number/);
  assert.match(concurrencyBlock, /github\.event\.pull_request\.number/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.activity\.issue\.number/);
  assert.match(concurrencyBlock, /github\.event\.issue\.number/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.activity\.subject\.number/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.activity\.label\.name/);
  assert.match(concurrencyBlock, /github\.event\.label\.name/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.activity\.assignee\.login/);
  assert.match(concurrencyBlock, /github\.event\.assignee\.login/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.activity\.delivery_id/);
  assert.match(concurrencyBlock, /github\.event\.client_payload\.activity\.idempotency_key/);
  assert.match(workflow, /Check core API budget/);
  assert.match(workflow, /CLAWSWEEPER_MIN_CORE_REMAINING/);
  assert.match(workflow, /contents: write/);
  assert.doesNotMatch(workflow, /Dispatch spam comment intake candidates/);
  assert.match(workflow, /Dispatch spam scan candidate/);
  assert.match(workflow, /repair:spam-comment-intake -- --write-report/);
  assert.doesNotMatch(workflow, /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/dispatches"/);
  assert.match(concurrencyBlock, /cancel-in-progress: true/);
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.doesNotMatch(workflow, /runs-on: blacksmith-/);
  assert.doesNotMatch(
    concurrencyBlock,
    /group: github-activity-\$\{\{ github\.event_name \}\}-\$\{\{ github\.run_id \}\}/,
  );
  assert.doesNotMatch(concurrencyBlock, /workflow-run' \|\| 'activity'/);
});
