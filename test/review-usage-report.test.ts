import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { createReviewActionLedger } from "../dist/clawsweeper-review-ledger.js";
import { flushWorkflowActionEvents } from "../dist/action-ledger-runtime.js";
import { isNativeReviewTerminal } from "../dist/review-recovery.js";
import { readReviewUsageReport } from "../dist/review-usage-report.js";
import { item } from "./helpers.ts";
import type { Item } from "../dist/clawsweeper-types.js";

async function fixture(t: TestContext, unfinished = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "review-usage-report-")));
  const previous = process.env;
  process.env = {
    ...previous,
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-11-26",
    CLAWSWEEPER_ACTION_LEDGER_DISABLED: "0",
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_RUN_ID: "12345",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_WORKFLOW: "fixture",
    GITHUB_WORKFLOW_REF: "",
    GITHUB_JOB: "review",
    GITHUB_SHA: "a".repeat(40),
  };
  t.after(() => {
    process.env = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const owner = createReviewActionLedger({
    root,
    targetRepo: () => "openclaw/openclaw",
    repoRelativePath: (path) => relative(root, path).replaceAll("\\", "/"),
    isRuntimeBudgetError: () => false,
  });
  const candidates = [1, 2, 3].map((number) => item({ number }) as Item);
  const ledger = owner.startReviewActionLedger({
    candidates,
    reviewPolicy: "fixture",
    shardIndex: 0,
    shardCount: 1,
    batchSize: 3,
  });
  const terminals = candidates.flatMap((candidate, index) => {
    owner.startReviewActionLedgerItem(ledger, candidate);
    if (unfinished && index === 2) return [];
    if (index !== 2)
      owner.recordReviewActionLedgerUsage(
        ledger,
        candidate,
        index === 0 ? { input_tokens: 100, output_tokens: 10 } : null,
      );
    return [
      owner.finishReviewActionLedgerItem({
        ledger,
        item: candidate,
        status: index === 1 ? "failed" : index === 2 ? "cached" : "completed",
        reasonCode: "completed",
        retryable: false,
        cached: index === 2,
        startedAtMs: Date.now(),
        sourceRevision: String(index + 1).repeat(64),
      })!,
    ];
  });
  if (!unfinished) owner.finishReviewActionLedger({ ledger, completedCount: 3, cacheHits: 1 });
  const paths = await flushWorkflowActionEvents(root, { outputRoot: root });
  return { root, paths, terminals };
}

test("offline usage report binds measured and unknown usage to native item attempts", async (t) => {
  const { root, paths, terminals } = await fixture(t);
  const report = readReviewUsageReport(root, paths);
  assert.equal(report.coverage.items, 3);
  assert.equal(report.coverage.measured_items, 1);
  assert.equal(report.coverage.cached_items, 1);
  assert.equal(report.coverage.unknown_usage_items, 1);
  assert.equal(report.coverage.actual_billing, "unavailable");
  const measured = report.rows.find((row) => row.subject.number === 1)!;
  assert.deepEqual(measured.usage, { input_tokens: 100, output_tokens: 10 });
  assert.equal(measured.operation_id, terminals[0]!.operation_id);
  assert.equal(measured.attempt_id, terminals[0]!.attempt_id);
  assert.equal(measured.producer.run_id, "12345");
  assert.equal(measured.producer.run_attempt, 2);
  assert.equal(measured.subject.source_revision, "1".repeat(64));
  assert.equal(report.rows.find((row) => row.subject.number === 2)!.usage, null);
  assert.equal(report.rows.find((row) => row.subject.number === 3)!.usage, null);
  for (const terminal of terminals) assert.equal(isNativeReviewTerminal(terminal), true);
  const cli = JSON.parse(
    execFileSync(process.execPath, [resolve("dist/review-usage-report.js"), root, ...paths], {
      encoding: "utf8",
    }),
  );
  assert.deepEqual(cli, report);
  assert.throws(() => readReviewUsageReport(root, []), /At least one/);
});

test("recovery rejects partial count pairs and counts attached to cached terminals", async (t) => {
  const { terminals } = await fixture(t);
  const measured = terminals[0]!;
  const { output_tokens: _output, ...incomplete } = measured.attributes!;
  assert.equal(isNativeReviewTerminal({ ...measured, attributes: incomplete }), false);
  assert.equal(
    isNativeReviewTerminal({
      ...measured,
      action: { ...measured.action, status: "cached" },
      attributes: { ...measured.attributes, cached: true },
    }),
    false,
  );
});

test("a started item without a terminal stays visible as missing coverage", async (t) => {
  const { root, paths } = await fixture(t, true);
  const report = readReviewUsageReport(root, paths);
  assert.equal(report.coverage.started_items, 3);
  assert.equal(report.coverage.missing_terminal_items, 1);
  assert.equal(report.coverage.items, 2);
});
