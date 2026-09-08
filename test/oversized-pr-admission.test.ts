import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createReviewCommandWorkflow } from "../dist/clawsweeper-review-command-workflow.js";
import { parseArgs } from "../dist/clawsweeper-args.js";
import { repositoryProfileFor } from "../dist/repository-profiles.js";
import { reviewActionForDecision } from "../dist/clawsweeper.js";
import { item } from "./helpers.ts";

for (const source of [
  "exact-event",
  "scheduled_hot_intake",
  "scheduled_normal_backfill",
  "shard",
]) {
  for (const total of [166686, 29999]) {
    test(`reviewCommand ${source}: ${total} lines is checked before cache, lease, hydration and model`, () => {
      const root = mkdtempSync(join(tmpdir(), "pr-admission-"));
      const calls = { metadata: 0, hydration: 0, scanner: 0, codex: 0, lease: 0, cache: 0 };
      const candidate = item({ kind: "pull_request", authorAssociation: "OWNER" });
      const rawPull = {
        number: candidate.number,
        title: candidate.title,
        body: "Synthetic admission body",
        comments: 0,
        review_comments: 0,
        state: "open",
        labels: [],
        additions: total,
        deletions: 0,
        changed_files: 2747,
        head: { sha: "b".repeat(40) },
        updated_at: candidate.updatedAt,
        draft: true,
      };
      const stop = new Error("CONTROL_REACHED_NORMAL_HYDRATION");
      const base = {
        activeReviewMutationRunner: null,
        asRecord: (value: unknown) => (value && typeof value === "object" ? value : {}),
        repoFromArgs: () => repositoryProfileFor(candidate.repo),
        targetRepo: () => candidate.repo,
        localExactReviewItem: () => false,
        defaultReviewArtifactDir: () => root,
        defaultItemsDir: () => root,
        resolveReviewCheckout: () => ({ openclawDir: root }),
        ensureDir: (path: string) => mkdirSync(path, { recursive: true }),
        reviewCodexForcedLoginMethod: () => "",
        suppliedReviewStartLeaseFromArgs: () => null,
        gitInfo: () => ({
          mainSha: "a".repeat(40),
          releaseStateComplete: true,
          latestRelease: null,
        }),
        reviewPolicyHash: () => "test-policy",
        selectCandidates: () => ({ candidates: [candidate], scannedPages: 1 }),
        startReviewActionLedger: () => ({ items: new Map(), startedAtMs: Date.now() }),
        startReviewActionLedgerItem: () => null,
        finishReviewActionLedgerItem: () => null,
        finishReviewActionLedger: () => null,
        reviewMutationRunner: () => null,
        restoreTreeModes: () => {},
        ghJson: () => {
          calls.metadata++;
          return rawPull;
        },
        itemSnapshotHash: () => "snapshot",
        itemContentDigest: () => "digest",
        reportFileName: () => "123.md",
        markdownFor: ({ decision, action }: any) => JSON.stringify({ decision, action }),
        reviewActionForDecision,
        collectItemContext: (_item: unknown, options: any) => {
          calls.hydration++;
          assert.equal(options.pullRequestPayload, rawPull);
          throw stop;
        },
        runReviewCheckoutInspection: () => {
          calls.scanner++;
          throw new Error("scanner must not run");
        },
        runCodex: () => {
          calls.codex++;
          throw new Error("model must not run");
        },
        postReviewStartStatusComment: () => {
          calls.lease++;
          throw new Error("lease must not run");
        },
        fetchReviewStructuralRecord: () => {
          calls.cache++;
          throw new Error("cache must not run");
        },
        existingReview: () => {
          if (total > 30000) throw new Error("oversized admission must precede cache lookup");
          return null;
        },
        frontMatterValue: () => undefined,
        bulkFilerPolicyInvalidatesCachedReview: () => false,
        localExactReviewHistoryPath: () => null,
        stringOrUndefined: (value: unknown) => (typeof value === "string" ? value : undefined),
      };
      const dependencies = new Proxy(base, {
        get(target, property) {
          if (property in target) return Reflect.get(target, property);
          return () => {
            throw new Error(`unexpected dependency: ${String(property)}`);
          };
        },
      });
      try {
        const { reviewCommand } = createReviewCommandWorkflow(dependencies as any);
        const args = parseArgs([
          "--target-repo",
          candidate.repo,
          "--artifact-dir",
          root,
          "--skip-start-comment",
          ...(source === "shard"
            ? ["--shard-count", "4", "--shard-index", "2"]
            : ["--item-number", "123", "--review-source-action", source]),
        ]);
        if (total > 30000) {
          reviewCommand(args);
          const report = JSON.parse(readFileSync(join(root, "123.md"), "utf8"));
          assert.equal(report.decision.closeReason, "oversized_pull_request");
          assert.equal(report.action.actionTaken, "proposed_close");
          assert.equal(report.decision.oversizedPullRequest.additions, total);
        } else {
          assert.throws(
            () => reviewCommand(args),
            (error) => error === stop,
          );
        }
        assert.deepEqual(calls, {
          metadata: 1,
          hydration: total > 30000 ? 0 : 1,
          scanner: 0,
          codex: 0,
          lease: 0,
          cache: 0,
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
