#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const proofDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(proofDir, "../../..");
const outputDir = process.env.APPLY_CURSOR_PROOF_OUTPUT
  ? path.resolve(process.env.APPLY_CURSOR_PROOF_OUTPUT)
  : proofDir;
const workflowUtilsPath = path.join(repoRoot, "dist/repair/workflow-utils.js");
const applyHelperPath = path.join(repoRoot, "scripts/apply-workflow-helpers.sh");

const productionSelection = [
  97566, 95788, 105342, 87267, 106572, 103879, 54578, 51049, 84583, 77625,
  92866, 86237, 116478, 90508, 90414, 14968, 51620, 7057, 99654, 76980,
  80234, 107099, 72721, 92460, 92201, 8299, 85937, 44925, 77306, 97680,
  90556, 87491, 79820, 77943, 90062, 107761, 120718, 121659, 84276, 105870,
];
const frontier = 105870;
const initialCursor = 105854;
const clippedItem = 85937;
const closedItem = 92460;
const adversarialSelection = [87267, 95788, 97566, 105342, frontier];
const examinedUrgentPrefix = productionSelection
  .slice(0, productionSelection.indexOf(clippedItem))
  .filter((number) => number !== closedItem);

const actionCycle = [
  "review_comment_synced",
  "skipped_changed_since_review",
  "review_comment_synced",
  "skipped_stale_review_comment_sync",
  "kept_open",
];

function writeCandidate(
  root,
  number,
  reviewedAt,
  regular = false,
  localCheckoutAccess = "verified",
) {
  const recordDir = path.join(root, "records/openclaw-openclaw/items");
  fs.mkdirSync(recordDir, { recursive: true });
  const lines = [
    "---",
    "repository: openclaw/openclaw",
    `type: ${regular ? "pull_request" : "issue"}`,
    "review_status: complete",
    `local_checkout_access: ${localCheckoutAccess}`,
    "item_snapshot_hash: synthetic-proof",
    "action_taken: kept_open",
    `reviewed_at: ${reviewedAt}`,
  ];
  if (regular) {
    lines.push(
      "review_comment_id: 9105870",
      "review_comment_url: https://github.com/openclaw/openclaw/pull/105870#issuecomment-9105870",
      `review_comment_sha256: ${"a".repeat(64)}`,
      `review_comment_synced_at: ${reviewedAt}`,
    );
  }
  lines.push("---", "");
  fs.writeFileSync(
    path.join(recordDir, `openclaw-openclaw-${number}.md`),
    `${lines.join("\n")}\n`,
  );
}

async function currentSelection() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apply-cursor-selection-"));
  try {
    const cursorPath = path.join(root, "results/comment-sync-cursors/openclaw-openclaw.json");
    fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
    fs.writeFileSync(cursorPath, JSON.stringify({ next_after_number: initialCursor }));
    productionSelection.slice(0, -1).forEach((number, index) => {
      writeCandidate(
        root,
        number,
        new Date(Date.UTC(2026, 7, 11, 23, 59, 59) - index * 1000).toISOString(),
      );
    });
    writeCandidate(root, frontier, "2026-08-11T22:00:00.000Z", true);
    const { commentSyncBatchOutput } = await import(`${pathToFileUrl(workflowUtilsPath)}?proof=1`);
    const previousCwd = process.cwd();
    try {
      process.chdir(root);
      return commentSyncBatchOutput({
        targetRepo: "openclaw/openclaw",
        applyKind: "all",
        batchSize: 40,
        cursorPath,
      });
    } finally {
      process.chdir(previousCwd);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function pathToFileUrl(filePath) {
  return new URL(`file://${filePath}`).href;
}

function applyAdversarialOrder() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apply-cursor-adversarial-"));
  try {
    const itemsDir = path.join(root, "items");
    const closedDir = path.join(root, "closed");
    const plansDir = path.join(root, "plans");
    const reportPath = path.join(root, "apply-report.json");
    const tracePath = path.join(root, "trace.json");
    fs.mkdirSync(plansDir, { recursive: true });
    adversarialSelection.forEach((number, index) => {
      writeCandidate(
        root,
        number,
        new Date(Date.UTC(2026, 7, 11, 23, 59, 59) - index * 1000).toISOString(),
        false,
        "unverified",
      );
    });
    const recordDir = path.join(root, "records/openclaw-openclaw/items");
    fs.renameSync(recordDir, itemsDir);

    execFileSync(
      process.execPath,
      [
        path.join(repoRoot, "dist/clawsweeper.js"),
        "apply-decisions",
        "--target-repo",
        "openclaw/openclaw",
        "--items-dir",
        itemsDir,
        "--closed-dir",
        closedDir,
        "--plans-dir",
        plansDir,
        "--report-path",
        reportPath,
        "--item-numbers",
        adversarialSelection.join(","),
        "--processed-limit",
        "1",
        "--limit",
        "0",
        "--close-delay-ms",
        "0",
        "--cursor-trace",
        tracePath,
        "--comment-sync-cursor",
        String(initialCursor),
      ],
      {
        encoding: "utf8",
        env: { ...process.env, GH_BIN: path.join(root, "missing-gh") },
      },
    );

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    const trace = JSON.parse(fs.readFileSync(tracePath, "utf8"));
    return {
      input_order: adversarialSelection,
      frontier_input_index: adversarialSelection.indexOf(frontier),
      first_executed: report[0]?.number ?? null,
      examined_item_numbers: trace.examined_item_numbers,
      completion: completeSelection(adversarialSelection, trace.examined_item_numbers, false),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function completeSelection(selected, examined, includeClosedRecord) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apply-cursor-complete-"));
  try {
    const cursorPath = path.join(root, "cursor.json");
    const tracePath = path.join(root, "trace.json");
    const reportPath = path.join(root, "report.json");
    fs.writeFileSync(cursorPath, JSON.stringify({ next_after_number: initialCursor }));
    fs.writeFileSync(
      tracePath,
      JSON.stringify({ schema_version: 1, examined_item_numbers: examined }),
    );
    fs.writeFileSync(
      reportPath,
      JSON.stringify(
        examined.map((number, index) => ({
          number,
          action: actionCycle[index % actionCycle.length],
          reason: "synthetic production-shaped terminal outcome",
        })),
      ),
    );
    if (includeClosedRecord) {
      const closedDir = path.join(root, "records/openclaw-openclaw/closed");
      fs.mkdirSync(closedDir, { recursive: true });
      fs.writeFileSync(path.join(closedDir, `${closedItem}.md`), "synthetic closed record\n");
    }
    const script = [
      'export PATH="$NODE_BIN_DIR:$PATH"',
      'pnpm() { while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ "$#" -gt 0 ] && shift; node "$WORKFLOW_UTILS_PATH" "$@"; }',
      'source "$APPLY_HELPER_PATH"',
      'TARGET_REPO="openclaw/openclaw"',
      "target_slug=openclaw-openclaw",
      'cursor_path="$CURSOR_PATH"',
      "sync_open_pr_batch=true",
      "scheduled_comment_sync=true",
      `comment_sync_initial_cursor=${initialCursor}`,
      `item_numbers=${selected.join(",")}`,
      `next_cursor=${frontier}`,
      'complete_comment_sync_batch "$REPORT_PATH" "$TRACE_PATH"',
      'printf "RESULT cursor=%s count=%s next=%s\\n" "$(jq -r .next_after_number "$cursor_path")" "$comment_sync_cursor_advance_count" "$next_cursor"',
    ].join("\n");
    const stdout = execFileSync("bash", ["-c", script], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_BIN_DIR: path.dirname(process.execPath),
        WORKFLOW_UTILS_PATH: workflowUtilsPath,
        APPLY_HELPER_PATH: applyHelperPath,
        CURSOR_PATH: cursorPath,
        REPORT_PATH: reportPath,
        TRACE_PATH: tracePath,
      },
    });
    const match = stdout.match(/RESULT cursor=(\d+) count=(\d+) next=(\d*)/);
    if (!match) throw new Error(`missing completion result: ${stdout}`);
    return {
      persisted_cursor: Number(match[1]),
      cursor_advance_count: Number(match[2]),
      next_cursor: match[3] ? Number(match[3]) : null,
      stdout: stdout.trim().split("\n"),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const batch = await currentSelection();
const currentOrder = batch.item_numbers.split(",").map(Number);
const oldOrderResult = completeSelection(productionSelection, examinedUrgentPrefix, true);
const currentExamined = [frontier, ...examinedUrgentPrefix];
const missingCurrentItems = currentExamined.filter((number) => !currentOrder.includes(number));
if (missingCurrentItems.length > 0) {
  throw new Error(`current selector omitted examined fixtures: ${missingCurrentItems.join(",")}`);
}
const currentOrderResult = completeSelection(currentOrder, currentExamined, true);
const clippedFrontierResult = completeSelection(currentOrder, [], false);
const adversarialOrderResult = applyAdversarialOrder();

const summary = {
  schema: "clawsweeper-apply-cursor-livelock-proof/v1",
  production_run: "https://github.com/openclaw/clawsweeper/actions/runs/31544381133",
  fixture: {
    initial_cursor: initialCursor,
    frontier,
    clipped_item: clippedItem,
    selected_count: productionSelection.length,
    terminal_urgent_count: examinedUrgentPrefix.length + 1,
  },
  old_order: {
    first_item: productionSelection[0],
    frontier_index: productionSelection.indexOf(frontier),
    ...oldOrderResult,
  },
  current_order: {
    first_item: currentOrder[0],
    frontier_index: currentOrder.indexOf(frontier),
    selector_next_cursor: Number(batch.next_cursor),
    ...currentOrderResult,
  },
  adversarial_order: adversarialOrderResult,
  clipped_frontier: clippedFrontierResult,
  assertions: {
    old_order_livelocks:
      oldOrderResult.persisted_cursor === initialCursor &&
      oldOrderResult.cursor_advance_count === 0,
    current_order_advances_terminal_frontier:
      currentOrder[0] === frontier &&
      currentOrderResult.persisted_cursor === frontier &&
      currentOrderResult.cursor_advance_count > 0,
    clipped_frontier_blocks:
      clippedFrontierResult.persisted_cursor === initialCursor &&
      clippedFrontierResult.cursor_advance_count === 0,
    apply_loop_executes_frontier_first:
      adversarialOrderResult.frontier_input_index === adversarialSelection.length - 1 &&
      adversarialOrderResult.first_executed === frontier &&
      adversarialOrderResult.examined_item_numbers[0] === frontier,
    adversarial_order_advances_terminal_frontier:
      adversarialOrderResult.completion.persisted_cursor === frontier &&
      adversarialOrderResult.completion.cursor_advance_count > 0,
  },
  limits: [
    "Synthetic filesystem records; no GitHub API calls or credentials.",
    "The fixture proves cursor ordering and completion semantics, not production API latency.",
  ],
};

if (!Object.values(summary.assertions).every(Boolean)) {
  throw new Error(`proof assertion failed: ${JSON.stringify(summary.assertions)}`);
}

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, "fixture-result.json"), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write("APPLY_CURSOR_FIXTURE_OK\n");
