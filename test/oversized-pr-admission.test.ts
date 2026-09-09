import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createReviewCommandWorkflow } from "../dist/clawsweeper-review-command-workflow.js";
import { suppliedReviewStartLeaseFromArgs } from "../dist/clawsweeper-review-lease.js";
import { parseArgs } from "../dist/clawsweeper-args.js";
import { repositoryProfileFor } from "../dist/repository-profiles.js";
import { reviewActionForDecision } from "../dist/clawsweeper.js";
import { item } from "./helpers.ts";

for (const source of [
  "exact-event",
  "scheduled_hot_intake",
  "scheduled_normal_backfill",
  "shard",
  "metadata-none",
  "metadata-none-json",
  "metadata-summary",
  "metadata-debug",
  "metadata-overflow",
]) {
  for (const total of source.startsWith("metadata-") ? [166686] : [166686, 49999]) {
    test(`reviewCommand ${source}: ${total} lines is checked before cache, lease, hydration and model`, () => {
      const root = mkdtempSync(join(tmpdir(), "pr-admission-"));
      const metadataOnly = source.startsWith("metadata-");
      const overflow = source === "metadata-overflow";
      const json = source === "metadata-none-json";
      const retention =
        overflow || json ? "none" : metadataOnly ? source.slice("metadata-".length) : "debug";
      const artifactDir = join(root, "output");
      const scratch = join(root, "tmp");
      mkdirSync(scratch);
      const previousTmpdir = process.env.TMPDIR;
      process.env.TMPDIR = scratch;
      const calls = {
        metadata: 0,
        hydration: 0,
        scanner: 0,
        codex: 0,
        lease: 0,
        cache: 0,
        checkout: 0,
        git: 0,
      };
      const completions: string[] = [];
      const startedItems: unknown[] = [];
      const finalizations: Array<{
        error?: unknown;
        activeItem?: unknown;
        completedCount: number;
      }> = [];
      const stdout: string[] = [];
      const previousLog = console.log;
      let observedReportPath = "";
      let renderedReport = "";
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
      const admissionPath = join(root, "admission.json");
      if (metadataOnly)
        writeFileSync(admissionPath, JSON.stringify({ repo: "OpenClaw/OpenClaw", pull: rawPull }));
      const stop = new Error("CONTROL_REACHED_NORMAL_HYDRATION");
      const base = {
        activeReviewMutationRunner: null,
        asRecord: (value: unknown) => (value && typeof value === "object" ? value : {}),
        repoFromArgs: () => repositoryProfileFor(candidate.repo),
        targetRepo: () => candidate.repo,
        localExactReviewItem: () => false,
        defaultReviewArtifactDir: () => artifactDir,
        defaultItemsDir: () => root,
        resolveReviewCheckout: () => {
          calls.checkout++;
          return { openclawDir: root };
        },
        ensureDir: (path: string) => mkdirSync(path, { recursive: true }),
        reviewCodexForcedLoginMethod: () => "",
        suppliedReviewStartLeaseFromArgs,
        gitInfo: () => {
          calls.git++;
          return { mainSha: "a".repeat(40), releaseStateComplete: true, latestRelease: null };
        },
        reviewPolicyHash: () => "test-policy",
        selectCandidates: () => {
          assert.equal(metadataOnly, false, "metadata handoff must supply its candidate");
          return { candidates: [candidate], scannedPages: 1 };
        },
        startReviewActionLedger: () => ({ items: new Map(), startedAtMs: Date.now() }),
        startReviewActionLedgerItem: (_ledger: unknown, activeItem: unknown) => {
          startedItems.push(activeItem);
        },
        finishReviewActionLedgerItem: ({ status, reportPath }: any) => {
          completions.push(status);
          if (status === "completed") {
            observedReportPath = reportPath;
            assert.equal(
              existsSync(reportPath),
              true,
              "ledger must observe the report before pruning",
            );
            assert.equal(
              JSON.parse(readFileSync(reportPath, "utf8")).decision.closeReason,
              "oversized_pull_request",
            );
          }
        },
        finishReviewActionLedger: (options: (typeof finalizations)[number]) => {
          finalizations.push(options);
          if (overflow) {
            assert.equal(
              readdirSync(scratch, { recursive: true }).some((path) => path.endsWith("123.md")),
              false,
              "overflow must not write a report before command failure finalization",
            );
          }
        },
        actionLedgerFailureDisposition: () => ({ status: "failed", retryable: false }),
        actionLedgerItemKey: () => `${candidate.repo}#${candidate.number}`,
        reviewMutationRunner: () => null,
        restoreTreeModes: () => {},
        ghJson: () => {
          calls.metadata++;
          return rawPull;
        },
        itemSnapshotHash: () => "snapshot",
        itemContentDigest: () => "digest",
        reportFileName: () => "123.md",
        markdownFor: (report: any) => {
          renderedReport = overflow ? "x".repeat(16 * 1024 * 1024 + 1) : JSON.stringify(report);
          return renderedReport;
        },
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
          if (total > 50000) throw new Error("oversized admission must precede cache lookup");
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
        console.log = (value?: unknown) => stdout.push(String(value));
        const { reviewCommand } = createReviewCommandWorkflow(dependencies as any);
        const args = parseArgs([
          "--target-repo",
          candidate.repo,
          "--output-retention",
          retention,
          ...(json ? ["--result-format", "json"] : []),
          ...(retention === "none" ? [] : ["--artifact-dir", artifactDir]),
          "--skip-start-comment",
          ...(metadataOnly ? ["--local-only", "--pr-admission-file", admissionPath] : []),
          ...(total > 50000 && !metadataOnly
            ? ["--review-lease-owner", "reserved-owner", "--review-lease-comment-id", "5602217053"]
            : []),
          ...(source === "shard"
            ? ["--shard-count", "4", "--shard-index", "2"]
            : ["--item-number", "123", "--review-source-action", source]),
        ]);
        if (metadataOnly) {
          assert.throws(
            () =>
              reviewCommand({
                ...args,
                review_lease_owner: "reserved-owner",
                review_lease_comment_id: "5602217053",
              }),
            /A supplied review lease cannot be used with local-only review/,
          );
        }
        if (overflow) {
          let failure: unknown;
          assert.throws(
            () => reviewCommand(args),
            (error) => {
              failure = error;
              return error instanceof Error && /exceeded.*limit/i.test(error.message);
            },
          );
          assert.deepEqual(completions, []);
          assert.equal(finalizations.length, 1);
          assert.equal(finalizations[0]!.error, failure);
          assert.equal(startedItems.length, 1);
          assert.equal(finalizations[0]!.activeItem, startedItems[0]);
          assert.equal(finalizations[0]!.completedCount, 0);
          assert.equal(observedReportPath, "");
          assert.deepEqual(stdout, []);
        } else if (total > 50000) {
          reviewCommand(args);
          assert.deepEqual(completions, ["completed"]);
          assert.equal(existsSync(observedReportPath), retention !== "none");
          const rendered = JSON.parse(renderedReport);
          assert.equal(rendered.reviewLeaseOwner, metadataOnly ? undefined : "reserved-owner");
          assert.equal(rendered.reviewLeaseCommentId, metadataOnly ? undefined : 5602217053);
          if (retention !== "none") {
            const report = JSON.parse(readFileSync(observedReportPath, "utf8"));
            assert.equal(report.decision.closeReason, "oversized_pull_request");
            assert.equal(report.action.actionTaken, "proposed_close");
            assert.equal(report.decision.oversizedPullRequest.additions, total);
          }
          if (retention === "summary") assert.deepEqual(readdirSync(artifactDir), ["123.md"]);
          if (retention === "none") {
            if (json) {
              assert.equal(stdout.length, 1);
              assert.deepEqual(JSON.parse(stdout[0]!), {
                status: "completed",
                retention: "none",
                reports: [
                  { item_number: candidate.number, artifact_path: null, report: renderedReport },
                ],
              });
            } else assert.deepEqual(stdout, [renderedReport]);
          }
        } else {
          assert.throws(
            () => reviewCommand(args),
            (error) => error === stop,
          );
        }
        assert.deepEqual(calls, {
          metadata: metadataOnly ? 0 : 1,
          hydration: total > 50000 ? 0 : 1,
          scanner: 0,
          codex: 0,
          lease: 0,
          cache: 0,
          checkout: metadataOnly ? 0 : 1,
          git: metadataOnly ? 0 : 1,
        });
        assert.deepEqual(readdirSync(scratch), [], "all private review scratch must be removed");
      } finally {
        console.log = previousLog;
        if (previousTmpdir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmpdir;
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

for (const script of ["proof-pr-admission-repo-case.mjs", "proof-oversized-pr-close.mjs"]) {
  test(`built review CLI admission proof: ${script}`, () => {
    const root = mkdtempSync(join(tmpdir(), "pr-admission-cli-"));
    let completed = false;
    try {
      const result = spawnSync(process.execPath, [join("scripts", script), root], {
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      });
      completed = !result.error && result.signal === null && result.status !== null;
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /Limits: synthetic Git/);
    } finally {
      // A timed-out proof script may still have a child using its fixture.
      if (completed) rmSync(root, { recursive: true, force: true });
    }
  });
}
