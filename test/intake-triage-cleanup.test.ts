import assert from "node:assert/strict";
import test from "node:test";
import { createLabelMutationOperations } from "../dist/clawsweeper-label-mutations.js";
import { createLabelSyncOperations } from "../dist/clawsweeper-label-operations.js";
import { syncApplyReportLabels } from "../dist/clawsweeper-apply-report-labels.js";
import type { Item, ItemContext } from "../dist/clawsweeper-types.js";
import { reportFrontMatter, withReviewRecord } from "./helpers.ts";

for (const kind of ["issue", "pull_request"] as const) {
  for (const scenario of ["complete", "incomplete", "blocked"] as const) {
    test(`normal ${kind} publisher removes finite intake labels only for ${scenario}`, () => {
      const writes: string[][] = [];
      const labels = createLabelMutationOperations({
        readLabelCatalogPages: () => [[]],
        ghObservedMutationCommand: (options) => {
          writes.push(options.args);
          options.onMutation?.();
          return "";
        },
      });
      const sync = createLabelSyncOperations(labels);
      const item: Item = {
        repo: "openclaw/openclaw",
        number: 42,
        kind,
        title: "Report",
        url: `https://github.com/openclaw/openclaw/${kind === "issue" ? "issues" : "pull"}/42`,
        createdAt: "2026-10-15T00:00:00Z",
        updatedAt: "2026-10-15T00:00:00Z",
        author: "contributor",
        authorAssociation: "CONTRIBUTOR",
        locked: false,
        labels: [
          "human-label",
          "clawsweeper:intake:bug",
          "clawsweeper:intake:needs-repro",
          "clawsweeper:intake:custom-human-label",
          "P1",
          "impact:crash-loop",
        ],
      };
      const unchanged = (options: { labels: readonly string[] }) => ({
        labels: [...options.labels],
        changed: false,
      });
      const dependencies: Parameters<typeof syncApplyReportLabels>[0] = {
        bulkFilerRepositoryPermission: () => null,
        closingPullRequestsForIssue: () => [],
        isBulkFilerExemptAuthorAssociation: () => false,
        openClosingPullRequestApplyReason: () => null,
        syncBulkFilerLabel: unchanged,
        syncImpactLabels: sync.syncImpactLabels,
        syncIssueAdvisoryLabels: unchanged,
        syncMaturityLabels: unchanged,
        syncMergeRiskLabels: unchanged,
        syncPriorityLabel: sync.syncPriorityLabel,
        syncIntakeLabels: labels.syncIntakeLabels,
      };
      let markdown = withReviewRecord(
        reportFrontMatter({
          repository: item.repo,
          type: kind,
          number: "42",
          labels: JSON.stringify(item.labels),
        }),
        {
          decision: "keep_open",
          closeReason: "none",
          triagePriority: "P2",
          impactLabels: ["impact:message-loss"],
        },
      );
      let receipt = false;
      labels.beginIssueLabelMutationBatch(42);
      const result = syncApplyReportLabels(dependencies, {
        bulkFilerRepositoryPermissionCache: new Map(),
        clawSweeperLabelsChanged: false,
        currentApplyMutationLeaseBlockReason: () =>
          scenario === "blocked" ? "newer_generation" : null,
        currentClosingPullRequests: undefined,
        currentItemContext: () => ({ item }) as ItemContext,
        dryRun: false,
        isCloseProposal: false,
        isCurrentCompleteReport: scenario !== "incomplete",
        isCurrentLabelSyncReport: false,
        item,
        markLabelSyncAuthSkipped: () => false,
        markdown,
        number: 42,
        onMutation: () => {},
        recordReviewLeaseSkip: () => false,
        rememberSelfMutationUpdatedAt: () => {
          receipt = true;
        },
        renderOptions: {},
        reportLabelsBeforeApply: [...item.labels],
        setMarkdown: (value) => {
          markdown = value;
        },
        state: "open",
      });
      if (result.skipCurrentItem) labels.discardIssueLabelMutationBatch(42);
      else labels.flushIssueLabelMutationBatch(42);
      if (scenario === "complete") {
        assert.deepEqual(item.labels, [
          "human-label",
          "clawsweeper:intake:custom-human-label",
          ...(kind === "pull_request"
            ? ["P1", "impact:crash-loop"]
            : ["P2", "impact:message-loss"]),
        ]);
        assert.equal(receipt, true);
        const edit = writes
          .find((args) => args[0] === "issue" && args[1] === "edit")
          ?.flatMap((arg) => arg.split(","));
        assert.ok(edit?.includes("clawsweeper:intake:bug"));
        assert.ok(edit?.includes("clawsweeper:intake:needs-repro"));
        assert.ok(!edit?.includes("clawsweeper:intake:custom-human-label"));
        if (kind === "pull_request") {
          assert.equal(writes.length, 1);
          assert.ok(!edit?.some((arg) => /^P[0-3]$/.test(arg) || arg.startsWith("impact:")));
        }
        assert.ok(!markdown.includes('"clawsweeper:intake:bug"'));
      } else {
        assert.ok(item.labels.includes("clawsweeper:intake:bug"));
        assert.ok(item.labels.includes("clawsweeper:intake:needs-repro"));
        assert.deepEqual(writes, []);
        assert.equal(receipt, false);
      }
    });
  }
}

test("intake cleanup joins a batch that can still be discarded before publication", () => {
  let writes = 0;
  const labels = createLabelMutationOperations({
    readLabelCatalogPages: () => [[]],
    ghObservedMutationCommand: () => {
      writes++;
      return "";
    },
  });
  labels.beginIssueLabelMutationBatch(42);
  labels.syncIntakeLabels({
    number: 42,
    labels: ["clawsweeper:intake:bug", "human"],
    wanted: [],
    dryRun: false,
  });
  labels.discardIssueLabelMutationBatch(42);
  labels.flushIssueLabelMutationBatch(42);
  assert.equal(writes, 0);
});
