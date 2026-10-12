#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const output = resolve(process.argv[3] || ".artifacts/queue-review-identity");
mkdirSync(output, { recursive: true });
const secret = "isolated-queue-identity-proof";
const itemKey = "openclaw/openclaw#74";
const head = "a".repeat(40);
const sourceRevision = "b".repeat(64);
const snapshotAt = "2026-05-01T00:00:00Z";
const progressAt = "2026-05-01T01:00:00Z";
const markdown = [
  "---",
  "type: pull_request",
  "number: 74",
  "repository: openclaw/openclaw",
  `reviewed_at: ${snapshotAt}`,
  `item_updated_at: ${snapshotAt}`,
  `pull_head_sha: ${head}`,
  `item_source_revision: ${sourceRevision}`,
  "review_lease_owner: github-run-1074-1",
  `review_queue_item_key: ${itemKey}`,
  "review_queue_lease_revision: 1",
  "review_queue_claim_generation: 1",
  "review_queue_run_id: 1074",
  "review_queue_run_attempt: 1",
  "---",
  "Review.",
].join("\n");

if (process.argv[2] === "server") {
  const { ExactReviewQueue, MemoryDurableStorage, leasedExactReviewQueueItem } =
    await import("../../test/dashboard-worker-harness.ts");
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewQueueItem(74, "1074");
  for (const decision of [item.decision, item.leaseDecision]) {
    decision.sourceHeadSha = head;
    decision.itemKind = "pull_request";
    decision.sourceEvent = "pull_request";
  }
  const save = () =>
    storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  await save();
  const queue = new ExactReviewQueue(
    { storage },
    {
      hostedTargetPredicate: () => true,
      hostedPublicTargetProbe: async () => "public",
    },
  );
  const trace = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.url === "/advance") {
      item.claimGeneration = 2;
      await save();
      response.end("advanced");
      return;
    }
    const route = request.url.replace("/internal/exact-review", "");
    if (route === "/publication-authority") {
      const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
      assert.equal(request.headers["x-clawsweeper-exact-review-signature"], expected);
    }
    const result = await queue.fetch(
      new Request(`https://queue${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
    const text = await result.text();
    trace.push({
      route,
      request: JSON.parse(body),
      status: result.status,
      response: JSON.parse(text),
    });
    writeFileSync(join(output, "queue-requests.json"), JSON.stringify(trace, null, 2));
    console.error(JSON.stringify(trace.at(-1)));
    response.writeHead(result.status, { "content-type": "application/json" });
    response.end(text);
  });
  server.listen(0, "127.0.0.1", () => console.log(server.address().port));
} else {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "server", output], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise((resolvePort, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`queue server exited ${code}`)));
    child.stdout.once("data", (data) => resolvePort(Number(String(data).trim())));
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    const bin = join(output, "bin");
    mkdirSync(bin, { recursive: true });
    const stockCurl = spawnSync("which", ["curl"], { encoding: "utf8" }).stdout.trim();
    assert.ok(stockCurl);
    writeFileSync(
      join(bin, "curl"),
      `#!/usr/bin/env node\nimport {spawnSync} from 'node:child_process';\nimport {appendFileSync} from 'node:fs';\nconst args=process.argv.slice(2).map(arg=>arg.replace('https://queue-proof.invalid',${JSON.stringify(base)}));\nconst result=spawnSync(${JSON.stringify(stockCurl)},args,{stdio:['inherit','pipe','pipe'],encoding:'utf8'});\nappendFileSync(${JSON.stringify(join(output, "curl-trace.jsonl"))},JSON.stringify({args,status:result.status,stdout:result.stdout,stderr:result.stderr,error:result.error?.message})+'\\n');\nprocess.stdout.write(result.stdout||'');\nprocess.stderr.write(result.stderr||'');\nprocess.exit(result.status ?? 1);\n`,
      { mode: 0o755 },
    );
    Object.assign(process.env, {
      PATH: `${bin}:${process.env.PATH}`,
      EXACT_REVIEW_QUEUE_URL: "https://queue-proof.invalid",
      CLAWSWEEPER_WEBHOOK_SECRET: secret,
      EXACT_REVIEW_ITEM_KEY: itemKey,
      EXACT_REVIEW_LEASE_ID: "lease-74",
      EXACT_REVIEW_LEASE_REVISION: "1",
      EXACT_REVIEW_CLAIM_GENERATION: "1",
      GITHUB_RUN_ID: "1074",
      GITHUB_RUN_ATTEMPT: "1",
    });
    const { createApplyLeaseGuards } = await import("../../dist/clawsweeper-apply-lease-guards.js");
    const { createApplySourceFreshness } =
      await import("../../dist/clawsweeper-apply-source-freshness.js");
    const { reviewVersionMarkerFromReport } =
      await import("../../dist/clawsweeper-review-comment-automation.js");
    const { durableReviewCausalIdentityFromBody } =
      await import("../../dist/clawsweeper-review-comment-state.js");
    const version = reviewVersionMarkerFromReport(markdown);
    const rendered = `${version}\n<!-- clawsweeper-review-state:ready item=74 sha=${head} v=1 -->\n<!-- clawsweeper-review item=74 -->`;
    const identity = durableReviewCausalIdentityFromBody(rendered, 74);
    assert.equal(identity.leaseIdentity.kind, "queue");
    assert.equal(identity.leaseCommentId, null);
    let publicLeaseWrites = 0;
    let liveHead = head;
    const guards = createApplyLeaseGuards({
      markdownBeforeApplyDecisionMutations: markdown,
      number: 74,
      targetRepo: () => "openclaw/openclaw",
      dryRun: false,
      requiresApplyMutationLease: true,
      currentReviewActivityBlock: () => null,
      item: { repo: "openclaw/openclaw", kind: "pull_request", number: 74 },
      initialReviewHeadSha: head,
      reportReviewRevision: head,
      ghJson: () => ({ head: { sha: liveHead } }),
      issueReviewCommentState: () => ({
        comments: [],
        leaseComments: [],
        reviewComment: { id: 9074, body: rendered, user: { login: "clawsweeper[bot]" } },
      }),
      canonicalBoundStaleReviewReason: () => null,
      PATCHABLE_REVIEW_COMMENT_AUTHORS: new Set(["clawsweeper[bot]"]),
      postReviewStartStatusComment: () => {
        publicLeaseWrites++;
        throw new Error("public lease forbidden");
      },
      GitHubRuntimeBudgetError: class extends Error {},
    });
    const acquired = guards.acquireApplyMutationLease({});
    assert.equal(acquired, null, acquired);
    assert.equal(guards.currentApplyMutationLeaseBlockReason(), null);
    assert.equal(publicLeaseWrites, 0);
    liveHead = "c".repeat(40);
    const sourceDriftBlock = guards.currentApplyMutationLeaseBlockReason();
    assert.match(sourceDriftBlock, /changed since context capture/);
    liveHead = head;
    const claim = await fetch(`${base}/claim`, {
      method: "POST",
      body: JSON.stringify({
        item_key: itemKey,
        lease_id: "lease-74",
        lease_revision: 1,
        run_id: "2074",
        run_attempt: 1,
      }),
    });
    assert.equal(claim.status, 409);
    const acknowledgement = {
      id: 10,
      user: { login: "clawsweeper[bot]" },
      updated_at: progressAt,
      body: "<!-- clawsweeper-pr-ack:opened item=74 -->\n<!-- clawsweeper-review-progress:start -->\n### ClawSweeper review complete\n<!-- clawsweeper-review-progress:end -->",
    };
    const freshness = createApplySourceFreshness(
      {
        CLAWSWEEPER_BOT_AUTHORS: new Set(["clawsweeper[bot]"]),
        commentBody: (comment) => comment?.body,
        commentId: (comment) => comment?.id,
        commentUpdatedAt: (comment) => comment?.updated_at,
        contextHasNonAutomationActivityAfter: () => false,
        freshPullRequestReviewHead: () => true,
        itemSnapshotHash: () => "snapshot",
        recordedLabelSyncCoversUpdate: () => false,
        reviewStartLeaseOwner: () => null,
      },
      {
        comments: [acknowledgement],
        completeReviewActivityReceiptMatches: () => true,
        currentItemContext: () => ({ issue: {}, comments: [], timeline: [] }),
        currentState: () => ({ isCloseProposal: true, markdown, storedUpdatedAt: snapshotAt }),
        existingReviewComment: { id: 11, updated_at: snapshotAt },
        item: {
          repo: "openclaw/openclaw",
          number: 74,
          kind: "pull_request",
          updatedAt: progressAt,
          labels: [],
        },
        leaseComments: [],
        markdownBeforeApplyDecisionMutations: markdown,
        number: 74,
        reportLabelsBeforeApply: [],
        reportReviewLeaseCommentId: 0,
        reportReviewLeaseOwner: "github-run-1074-1",
        reviewHasCompleteActivityIdentity: true,
        requiresApplyMutationLease: true,
        storedHash: "snapshot",
      },
    );
    assert.equal(freshness.reviewedSourceFresh(), true);
    const {
      canonicalPullRequestClusterForTest,
      emptyReviewedPrActivityCursor,
      lowSignalCloseReport,
      promotionGhMock,
      reportWithSyncedReviewComment,
      withMockCodexProof,
      withMockGh,
    } = await import("../../test/helpers.ts");
    const title = "Provider route fallback";
    const labels = ["rating: 🌊 off-meta tidepool"];
    const cliRoot = join(output, "apply-cli");
    const items = join(cliRoot, "items");
    mkdirSync(items, { recursive: true });
    mkdirSync(join(cliRoot, "plans"), { recursive: true });
    const cliReport = reportWithSyncedReviewComment(
      lowSignalCloseReport({
        number: 74,
        title,
        labels: JSON.stringify(labels),
        item_updated_at: snapshotAt,
        reviewed_at: snapshotAt,
        item_source_revision: createHash("sha256")
          .update(
            JSON.stringify({
              title,
              body: "Stale PR body.",
              labels: [],
              comments: [],
            }),
          )
          .digest("hex"),
        review_timeline_revision: createHash("sha256").update("[]").digest("hex"),
        review_activity_cursor: emptyReviewedPrActivityCursor,
        pull_head_sha: head,
        close_reason: "duplicate_or_superseded",
        work_cluster_refs: JSON.stringify([
          "Superseded by https://github.com/openclaw/openclaw/pull/400",
        ]),
        root_cause_cluster: canonicalPullRequestClusterForTest(
          "https://github.com/openclaw/openclaw/pull/400",
        ),
        review_lease_owner: "github-run-1074-1",
        review_queue_item_key: itemKey,
        review_queue_lease_revision: 1,
        review_queue_claim_generation: 1,
        review_queue_run_id: "1074",
        review_queue_run_attempt: 1,
      }).replace(
        "Closing this PR because the branch is not a useful landing base.",
        "Closing this PR as superseded by https://github.com/openclaw/openclaw/pull/400.",
      ),
      74,
      "duplicate_or_superseded",
    );
    writeFileSync(join(items, "74.md"), cliReport.report);
    const requestLog = join(cliRoot, "requests.jsonl");
    const proofLog = join(cliRoot, "coverage-proof.log");
    const applyReport = join(cliRoot, "apply-report.json");
    const legacyComment = [
      "Codex review: previous manual review.",
      `<!-- clawsweeper-review-version item=74 reviewed_at=${snapshotAt} sha=${head} source_revision=${sourceRevision} lease_owner=previous-run lease_comment_id=9000 v=1 -->`,
      "<!-- clawsweeper-review item=74 -->",
    ].join("\n\n");
    const mock = promotionGhMock({
      number: 74,
      title,
      labels,
      headSha: head,
      itemUpdatedAt: progressAt,
      comment: legacyComment,
      comments: [
        {
          id: 9074,
          user: { login: "clawsweeper[bot]" },
          created_at: snapshotAt,
          updated_at: snapshotAt,
          body: legacyComment,
        },
        acknowledgement,
      ],
      commandLogPath: requestLog,
      linkedPulls: {
        400: {
          number: 400,
          title: "Provider cleanup",
          html_url: "https://github.com/openclaw/openclaw/pull/400",
          state: "closed",
          merged_at: "2026-05-02T00:00:00Z",
          body: "Includes the fallback route behavior.",
          comments: [],
          labels: [],
        },
      },
    });
    let cli;
    let dryRun;
    let background;
    withMockGh(cliRoot, mock, () =>
      withMockCodexProof(
        cliRoot,
        {
          type: "decision",
          decision: "covered",
          reason: "The merged canonical PR includes the fallback.",
          invocationLogPath: proofLog,
        },
        () => {
          const args = [
            "dist/clawsweeper.js",
            "apply-decisions",
            "--target-repo",
            "openclaw/openclaw",
            "--items-dir",
            items,
            "--closed-dir",
            join(cliRoot, "closed"),
            "--plans-dir",
            join(cliRoot, "plans"),
            "--report-path",
            applyReport,
            "--limit",
            "1",
            "--processed-limit",
            "3",
            "--close-delay-ms",
            "0",
            "--apply-kind",
            "all",
            "--skip-dashboard",
            "--item-number",
            "74",
          ];
          const unfencedEnv = { ...process.env };
          for (const key of Object.keys(unfencedEnv)) {
            if (key.startsWith("EXACT_REVIEW_")) delete unfencedEnv[key];
          }
          dryRun = spawnSync(process.execPath, [...args, "--dry-run"], {
            encoding: "utf8",
            env: unfencedEnv,
          });
          assert.equal(dryRun.status, 0, dryRun.stderr);
          background = spawnSync(process.execPath, args, { encoding: "utf8", env: unfencedEnv });
          assert.equal(background.status, 0, background.stderr);
          cli = spawnSync(process.execPath, [...args, "--exact-event-publication"], {
            encoding: "utf8",
          });
        },
      ),
    );
    writeFileSync(join(cliRoot, "stdout.log"), cli.stdout);
    writeFileSync(join(cliRoot, "stderr.log"), cli.stderr);
    assert.equal(cli.status, 0, cli.stderr);
    const cliOutcome = JSON.parse(readFileSync(applyReport, "utf8")).at(-1);
    assert.equal(cliOutcome.action, "closed", JSON.stringify(cliOutcome));
    const cliRequests = readFileSync(requestLog, "utf8").trim().split("\n").map(JSON.parse);
    const leasePosts = cliRequests.filter((args) => {
      if (!args.includes("POST") || !args.includes("repos/openclaw/openclaw/issues/74/comments"))
        return false;
      const payloadPath = args[args.indexOf("--input") + 1];
      const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
      return (
        payload.body.includes("<!-- clawsweeper-review-status:started") ||
        payload.body.includes("<!-- clawsweeper-review-lease")
      );
    });
    assert.equal(leasePosts.length, 0, "apply must not POST a public lease");
    for (const path of [
      requestLog,
      join(cliRoot, "stdout.log"),
      join(cliRoot, "stderr.log"),
      applyReport,
    ]) {
      writeFileSync(
        path,
        readFileSync(path, "utf8")
          .replaceAll(cliRoot, "<fixture>")
          .replaceAll(process.cwd(), "<checkout>"),
      );
    }
    await fetch(`${base}/advance`, { method: "POST" });
    const revoked = guards.currentApplyMutationLeaseBlockReason();
    assert.match(revoked, /queue publication authority check failed/);
    const result = {
      stage: "dual-readers-before-writer-cutover",
      revision: spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
      dirty: Boolean(
        spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" }).stdout.trim(),
      ),
      queue_identity_round_trip: identity.leaseIdentity,
      public_lease_writes_from_queue_apply_guard: publicLeaseWrites,
      competing_claim_status: claim.status,
      own_acknowledgement_freshness: freshness.reviewedSourceFresh(),
      revoked_generation_block: revoked,
      source_drift_before_queue_event: sourceDriftBlock,
      unfenced_dry_run_exit: dryRun.status,
      unfenced_background_exit: background.status,
      apply_cli_action: cliOutcome.action,
      apply_cli_public_lease_posts: leasePosts.length,
      limits:
        "Controlled queue Durable Object with repository SQLite test storage and HTTP bridge; apply uses the shipped CLI with controlled GitHub and coverage-proof processes. Production auth, model quality, notifications and workflow reaction/progress writes are not exercised. Existing review writers are unchanged in stage 1.",
    };
    writeFileSync(join(output, "result.json"), JSON.stringify(result, null, 2));
    writeFileSync(join(output, "rendered-marker.txt"), rendered);
    console.log(JSON.stringify(result));
  } finally {
    child.kill();
  }
}
