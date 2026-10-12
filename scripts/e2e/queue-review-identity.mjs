#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  let scenario = "guard";
  let mutationRequests = 0;
  const record = (entry) => {
    trace.push({ scenario, ...entry });
    writeFileSync(join(output, "queue-requests.json"), JSON.stringify(trace, null, 2));
    console.error(JSON.stringify(trace.at(-1)));
  };
  const server = createServer(async (request, response) => {
    // The caller blocks while shipped synchronous CLIs run; do not retain an idle socket.
    response.setHeader("connection", "close");
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.url === "/scenario") {
      const next = JSON.parse(body);
      scenario = next.name;
      mutationRequests = 0;
      item.claimGeneration = next.generation ?? 1;
      item.claimedRunId = next.runId ?? "1074";
      await save();
      response.end("ready");
      return;
    }
    if (request.url === "/advance") {
      item.claimGeneration++;
      await save();
      response.end("advanced");
      return;
    }
    if (request.url === "/github-mutation" || request.url === "/github-effect") {
      const mutation = JSON.parse(body);
      const failed =
        request.url === "/github-mutation" &&
        scenario === "retry-revocation" &&
        mutationRequests++ === 0;
      const status = failed ? 503 : 200;
      record({ route: request.url, request: mutation, status });
      if (failed) {
        item.claimGeneration++;
        item.claimedRunId = "2074";
        await save();
      }
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: !failed }));
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
    record({
      route,
      request: JSON.parse(body),
      status: result.status,
      response: JSON.parse(text),
    });
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
    // Trace at the external GitHub process boundary, before the fixture can apply
    // an effect. The queue child can revoke authority while the CLI is blocked.
    const trackedMock = (root) => {
      const fixturePath = join(root, "bin", "promotion.cjs");
      mkdirSync(join(root, "bin"), { recursive: true });
      writeFileSync(fixturePath, mock);
      return `
const { spawnSync } = require("node:child_process");
const { appendFileSync, readFileSync } = require("node:fs");
const raw = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(root, "requests.jsonl"))}, JSON.stringify(raw) + "\\n");
const args = raw[0] === "--repo" ? raw.slice(2) : raw;
const methodIndex = args.findIndex(arg => arg === "--method" || arg === "-X");
const method = methodIndex < 0 ? (args.some(arg => ["--input", "-f", "-F", "--field", "--raw-field"].includes(arg)) ? "POST" : "GET") : args[methodIndex + 1];
const mutation = args[0] === "api" ? (args[1] === "graphql"
  ? args.some(arg => /^query=\\s*mutation\\b/.test(arg)) : !["GET", "HEAD"].includes(method)) :
  ["pr", "issue", "label"].includes(args[0]) && !["view", "list", "status"].includes(args[1]);
const inputIndex = args.indexOf("--input");
const payload = inputIndex < 0 ? null : JSON.parse(readFileSync(args[inputIndex + 1], "utf8"));
const event = { args: raw, method, payload };
function record(route) {
  const response = spawnSync(${JSON.stringify(stockCurl)}, [
    "--silent", "--show-error", "--max-time", "5", "--write-out", "%{http_code}",
    "--header", "content-type: application/json", "--data-binary", JSON.stringify(event),
    ${JSON.stringify(base)} + route
  ], { encoding: "utf8" });
  if (response.status !== 0) throw new Error(response.stderr || "trace transport failed");
  return Number(response.stdout.slice(-3));
}
if (mutation) {
  const status = record("/github-mutation");
  if (status !== 200) {
    console.error("gh: Service Unavailable (HTTP " + status + ")");
    process.exit(1);
  }
}
const result = spawnSync(process.execPath, [${JSON.stringify(fixturePath)}, ...raw], { encoding: "utf8" });
if (mutation && result.status === 0 && record("/github-effect") !== 200) throw new Error("effect trace failed");
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
process.exit(result.status ?? 1);
`;
    };
    const scenarioTrace = (name) =>
      JSON.parse(readFileSync(join(output, "queue-requests.json"), "utf8")).filter(
        (entry) => entry.scenario === name,
      );
    const mutations = (trace) => trace.filter((entry) => entry.route === "/github-mutation");
    const effects = (trace) => trace.filter((entry) => entry.route === "/github-effect");
    const selectScenario = async (name, generation = 1) => {
      const response = await fetch(`${base}/scenario`, {
        method: "POST",
        body: JSON.stringify({ name, generation }),
      });
      assert.equal(response.status, 200);
    };
    await selectScenario("success");
    let cli;
    let dryRun;
    let background;
    let applyArgs;
    withMockGh(cliRoot, trackedMock(cliRoot), () =>
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
          applyArgs = args;
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
          assert.equal(
            mutations(scenarioTrace("success")).length,
            0,
            "dry-run and unfenced background apply must not mutate GitHub",
          );
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
    const leasePosts = mutations(scenarioTrace("success")).filter(
      ({ request }) =>
        request.method === "POST" &&
        typeof request.payload?.body === "string" &&
        /<!-- clawsweeper-review-(?:status:started|lease)/.test(request.payload.body),
    );
    assert.equal(leasePosts.length, 0, "apply must not POST a public lease");
    assert.ok(
      effects(scenarioTrace("success")).length > 0,
      "successful apply must publish effects",
    );
    const negativeCases = {};
    for (const name of ["competing-run", "stale-generation", "retry-revocation"]) {
      await selectScenario(name, name === "stale-generation" ? 2 : 1);
      const root = join(output, name);
      mkdirSync(join(root, "items"), { recursive: true });
      mkdirSync(join(root, "plans"), { recursive: true });
      writeFileSync(join(root, "items", "74.md"), cliReport.report);
      let denied;
      withMockGh(root, trackedMock(root), () =>
        withMockCodexProof(
          root,
          {
            type: "decision",
            decision: "covered",
            reason: "The merged canonical PR includes the fallback.",
            invocationLogPath: join(root, "coverage-proof.log"),
          },
          () => {
            denied = spawnSync(
              process.execPath,
              [
                ...applyArgs.map((arg) => arg.replaceAll(cliRoot, root)),
                "--exact-event-publication",
              ],
              {
                encoding: "utf8",
                env: {
                  ...process.env,
                  ...(name === "competing-run" ? { GITHUB_RUN_ID: "2074" } : {}),
                },
              },
            );
          },
        ),
      );
      writeFileSync(join(root, "stdout.log"), denied.stdout);
      writeFileSync(join(root, "stderr.log"), denied.stderr);
      assert.equal(denied.signal, null, `${name}: ${denied.stderr}`);
      assert.notEqual(denied.status, null, `${name}: ${denied.error}`);
      const trace = scenarioTrace(name);
      const requests = mutations(trace);
      const applied = effects(trace);
      const fences = trace.filter((entry) => entry.route === "/publication-authority");
      assert.equal(applied.length, 0, `${name} must not apply any GitHub effect`);
      assert.ok(
        fences.some((entry) => entry.status === 409),
        `${name} must reach the queue fence`,
      );
      assert.equal(
        requests.length,
        name === "retry-revocation" ? 1 : 0,
        `${name} must not dispatch forbidden comments, labels, or closes`,
      );
      if (name === "retry-revocation") {
        assert.equal(requests[0].status, 503);
        const failedIndex = trace.indexOf(requests[0]);
        assert.ok(
          trace
            .slice(0, failedIndex)
            .some((entry) => entry.route === "/publication-authority" && entry.status === 200),
        );
        assert.ok(
          trace
            .slice(failedIndex + 1)
            .some((entry) => entry.route === "/publication-authority" && entry.status === 409),
        );
        assert.match(
          denied.stderr,
          /Transient GitHub API failure; retrying/,
          "the shipped GitHub retry machinery must attempt the fenced retry",
        );
      }
      const reportPath = join(root, "apply-report.json");
      // Initial authority rejection exits before an item result is opened.
      const outcomes = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : [];
      assert.match(
        denied.stdout + denied.stderr,
        /fence is unavailable or expired|queue publication authority check failed/,
      );
      if (name !== "retry-revocation") assert.equal(denied.status, 1);
      else
        assert.ok(
          denied.status !== 0 ||
            outcomes.some((outcome) => String(outcome.action).startsWith("skipped")),
        );
      assert.ok(
        outcomes.every((outcome) => outcome.action !== "closed"),
        `${name} must not report a successful close`,
      );
      negativeCases[name] = {
        exit: denied.status,
        outcomes,
        mutation_requests: requests.length,
        github_effects: applied.length,
        authority_statuses: fences.map((entry) => entry.status),
        trace,
      };
      writeFileSync(join(root, "trace.json"), JSON.stringify(trace, null, 2));
    }
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
      successful_apply: { action: cliOutcome.action, trace: scenarioTrace("success") },
      negative_apply_cases: negativeCases,
      limits:
        "Controlled queue Durable Object with repository SQLite test storage and HTTP bridge; apply uses the shipped CLI with controlled GitHub and coverage-proof processes. Production auth, model quality, notifications and workflow reaction/progress writes are not exercised. Existing review writers are unchanged in stage 1.",
    };
    const redact = (text) =>
      text
        .replaceAll(process.cwd(), "<checkout>")
        .replaceAll(output, "<proof>")
        .replaceAll(base, "<local-queue>")
        .replaceAll("https://queue-proof.invalid", "<queue-origin>");
    for (const name of ["competing-run", "stale-generation", "retry-revocation"]) {
      for (const file of [
        "stdout.log",
        "stderr.log",
        "trace.json",
        "requests.jsonl",
        "apply-report.json",
      ]) {
        const path = join(output, name, file);
        if (existsSync(path)) writeFileSync(path, redact(readFileSync(path, "utf8")));
      }
    }
    const queueTracePath = join(output, "queue-requests.json");
    writeFileSync(queueTracePath, redact(readFileSync(queueTracePath, "utf8")));
    writeFileSync(join(output, "result.json"), redact(JSON.stringify(result, null, 2)));
    writeFileSync(join(output, "rendered-marker.txt"), rendered);
    console.log(redact(JSON.stringify(result)));
  } finally {
    child.kill();
  }
}
