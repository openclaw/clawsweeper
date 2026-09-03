import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import YAML from "yaml";
import { readFileSync } from "node:fs";

const workflowPath = ".github/workflows/exact-review-dead-letter-operator.yml";
const workflowSource = readFileSync(workflowPath, "utf8");
const workflow = YAML.parse(workflowSource);
const reconcileWorkflowPath = ".github/workflows/exact-review-dead-letter-reconcile.yml";

test("dead-letter workflow is manual, serialized, and bounded to safe actions", () => {
  assert.equal(workflow.on.schedule, undefined);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.action.options, [
    "inventory",
    "recover-fresh",
    "resolve",
  ]);
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.deepEqual(workflow.permissions, {
    contents: "read",
    issues: "read",
    "pull-requests": "read",
  });
  assert.equal(workflow.jobs.operate.environment, "exact-review-operator");
  assert.doesNotMatch(workflowSource, /dead-letters\/replay/);
  assert.match(workflowSource, /actions\/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0/);
  assert.match(workflowSource, /actions\/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e/);
  assert.match(workflowSource, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/);
  const uploadStep = workflow.jobs.operate.steps.find(
    (step) => step.name === "Upload sanitized inventory",
  );
  assert.equal(uploadStep.with["include-hidden-files"], true);
  assert.equal(workflow.jobs.operate.env.CLAWSWEEPER_WEBHOOK_SECRET, undefined);
  const operatorStep = workflow.jobs.operate.steps.find(
    (step) => step.name === "Inventory or operate dead letters",
  );
  assert.equal(
    operatorStep.env.CLAWSWEEPER_WEBHOOK_SECRET,
    "${{ secrets.EXACT_REVIEW_OPERATOR_SECRET }}",
  );
  assert.equal(
    operatorStep.env.CLAWSWEEPER_APP_PRIVATE_KEY,
    "${{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY }}",
  );
  assert.equal(operatorStep.env.EXACT_REVIEW_TARGET_TOKEN_MODE, "github-app");
  assert.equal(operatorStep.env.GH_TOKEN, undefined);
  assert.equal(operatorStep.env.GITHUB_TOKEN, "${{ github.token }}");
  assert.match(operatorStep.run, /operator:\$\{GITHUB_RUN_ID\}/);
  assert.doesNotMatch(operatorStep.run, /GITHUB_RUN_ATTEMPT/);
});

test("automatic dead-letter reconciliation is scheduled, bounded, and least privileged", () => {
  const source = readFileSync(reconcileWorkflowPath, "utf8");
  const scheduled = YAML.parse(source);
  assert.equal(scheduled.on.schedule[0].cron, "*/5 * * * *");
  assert.equal(scheduled.concurrency.group, workflow.concurrency.group);
  assert.equal(scheduled.concurrency["cancel-in-progress"], false);
  assert.deepEqual(scheduled.permissions, {
    actions: "write",
    ...workflow.permissions,
  });
  assert.equal(scheduled.jobs.reconcile.environment, "exact-review-operator");
  assert.equal(scheduled.on.workflow_dispatch.inputs.execute.default, false);
  assert.equal(scheduled.on.workflow_dispatch.inputs.max_targets.default, "100");
  assert.equal(scheduled.on.workflow_dispatch.inputs.max_recoveries.default, "10");
  assert.equal(scheduled.on.workflow_dispatch.inputs.force_unchanged.default, false);
  const deadline = scheduled.jobs.reconcile.steps.find(
    (candidate) => candidate.name === "Establish reconciliation deadline",
  );
  assert.match(deadline.run, /EXACT_REVIEW_RECONCILE_DEADLINE_MS/);
  assert.match(deadline.run, /13 \* 60 \* 1000/);
  assert.match(deadline.run, /GITHUB_ENV/);
  assert.ok(
    scheduled.jobs.reconcile.steps.indexOf(deadline) <
      scheduled.jobs.reconcile.steps.findIndex((candidate) =>
        candidate.uses?.startsWith("actions/checkout@"),
      ),
  );
  const step = scheduled.jobs.reconcile.steps.find(
    (candidate) => candidate.name === "Reconcile closed, duplicate, and recoverable dead letters",
  );
  assert.equal(step.env.CLAWSWEEPER_WEBHOOK_SECRET, "${{ secrets.EXACT_REVIEW_OPERATOR_SECRET }}");
  assert.equal(scheduled.jobs.reconcile.env.CLAWSWEEPER_WEBHOOK_SECRET, undefined);
  assert.match(step.run, /--max-targets "\$MAX_TARGETS"/);
  assert.match(step.run, /--max-recoveries "\$MAX_RECOVERIES"/);
  assert.equal(step.env.CLAWSWEEPER_APP_PRIVATE_KEY, "${{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY }}");
  assert.equal(step.env.EXACT_REVIEW_TARGET_TOKEN_MODE, "github-app");
  assert.equal(step.env.GH_TOKEN, undefined);
  assert.equal(step.env.GITHUB_TOKEN, "${{ github.token }}");
  const guard = scheduled.jobs.reconcile.steps.find(
    (candidate) => candidate.name === "Verify live recovery guards",
  );
  assert.match(guard.run, /\/api\/health/);
  assert.match(guard.run, /\.deployment_sha/);
  assert.match(guard.run, /live_deploy_sha.*expected_deploy_sha/);
  assert.match(guard.run, /git fetch --no-tags --depth=1 origin "\$live_deploy_sha"/);
  assert.match(guard.run, /dashboard\/exact-review-queue\.ts/);
  assert.match(guard.run, /live_guard_blob.*expected_guard_blob/);
  const parked = scheduled.jobs.reconcile.steps.find(
    (candidate) => candidate.name === "Reconcile terminal and open parked reviews",
  );
  assert.equal(
    parked.env.CLAWSWEEPER_WEBHOOK_SECRET,
    "${{ secrets.EXACT_REVIEW_OPERATOR_SECRET }}",
  );
  assert.equal(
    parked.env.CLAWSWEEPER_APP_PRIVATE_KEY,
    "${{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY }}",
  );
  assert.equal(parked.env.EXACT_REVIEW_TARGET_TOKEN_MODE, "github-app");
  assert.equal(parked.env.GH_TOKEN, undefined);
  assert.equal(parked.env.GITHUB_TOKEN, "${{ github.token }}");
  assert.match(parked.run, /--action reconcile-parked/);
  assert.match(parked.run, /--max-targets "\$MAX_TARGETS"/);
  assert.match(parked.run, /--max-recoveries 5/);
  assert.match(parked.run, /--force-unchanged/);
  assert.match(parked.env.FORCE_UNCHANGED, /workflow_dispatch/);
  assert.match(parked.run, /parked-reviews\.json/);
  const upload = scheduled.jobs.reconcile.steps.find(
    (candidate) => candidate.name === "Upload sanitized inventory",
  );
  assert.match(upload.with.path, /inventory\.json/);
  assert.match(upload.with.path, /parked-reviews\.json/);
  assert.doesNotMatch(source, /dead-letters\/replay/);
});

test("target-read App mode fails at startup for every incomplete credential pair", async () => {
  const secret = "test-target-read-credential-validation";
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let inventoryRequests = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the signed request body before replying.
    }
    inventoryRequests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, dead_letters: [], next_cursor: null }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const queueUrl = `http://127.0.0.1:${address.port}`;
  const directory = await mkdtemp(join(tmpdir(), "clawsweeper-target-read-credentials-"));
  const commonEnv = {
    EXACT_REVIEW_TARGET_TOKEN_MODE: "github-app",
    CLAWSWEEPER_APP_ID: "",
    CLAWSWEEPER_APP_CLIENT_ID: "",
    CLAWSWEEPER_APP_PRIVATE_KEY: "",
  };
  try {
    const matrix = [
      {
        name: "private key only",
        env: { ...commonEnv, CLAWSWEEPER_APP_PRIVATE_KEY: privateKey },
        missing: /missing CLAWSWEEPER_APP_CLIENT_ID or CLAWSWEEPER_APP_ID\n/,
      },
      {
        name: "App id only",
        env: { ...commonEnv, CLAWSWEEPER_APP_CLIENT_ID: "Iv23partial" },
        missing: /missing CLAWSWEEPER_APP_PRIVATE_KEY\n/,
      },
      {
        name: "neither credential",
        env: commonEnv,
        missing:
          /missing CLAWSWEEPER_APP_CLIENT_ID or CLAWSWEEPER_APP_ID and CLAWSWEEPER_APP_PRIVATE_KEY\n/,
      },
    ];
    const incompleteResults = [];
    for (const scenario of matrix) {
      incompleteResults.push({
        scenario,
        result: await runOperator(
          ["--action", "inventory", "--output", join(directory, `${scenario.name}.json`)],
          queueUrl,
          secret,
          scenario.env,
        ),
      });
    }
    assert.deepEqual(
      incompleteResults.map(({ scenario, result }) => ({ name: scenario.name, code: result.code })),
      matrix.map(({ name }) => ({ name, code: 1 })),
    );
    for (const { scenario, result } of incompleteResults) {
      assert.match(result.stderr, scenario.missing, scenario.name);
    }

    const complete = await runOperator(
      ["--action", "inventory", "--output", join(directory, "complete.json")],
      queueUrl,
      secret,
      {
        ...commonEnv,
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23complete",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
      },
    );
    assert.equal(complete.code, 0, complete.stderr);

    const actionsOptIn = await runOperator(
      ["--action", "inventory", "--output", join(directory, "actions.json")],
      queueUrl,
      secret,
      { ...commonEnv, EXACT_REVIEW_TARGET_TOKEN_MODE: "actions" },
    );
    assert.equal(actionsOptIn.code, 0, actionsOptIn.stderr);
    assert.equal(inventoryRequests, 2);
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("parked review reconciliation plans by default and executes terminal resolve plus open recovery", async () => {
  const secret = "test-parked-review-reconcile";
  const mutations = [];
  let queuePressure = "idle";
  const parkedRows = [
    parkedRow("openclaw/repo#1", "openclaw/repo", 1, 1_000),
    {
      ...parkedRow("openclaw/repo#2", "openclaw/repo", 2, 2_000),
      item_kind: "pull_request",
      source_head_sha: "a".repeat(40),
      source_base_sha: "b".repeat(40),
      source_is_draft: false,
      source_content_revision: "c".repeat(64),
    },
    parkedRow("gone/repo#3", "gone/repo", 3, 3_000),
    {
      ...parkedRow("openclaw/repo#4", "openclaw/repo", 4, 4_000),
      excluded_reason: "command_context",
    },
    {
      ...parkedRow("openclaw/repo#5", "openclaw/repo", 5, 5_000),
      source_content_revision: createHash("sha256")
        .update(
          JSON.stringify({
            version: 2,
            title: "Issue 5",
            body: "changed source",
            locked: false,
            close_guard_labels: [],
          }),
        )
        .digest("hex"),
    },
  ];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.url === "/api/exact-review-queue") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          pressure: {
            status: queuePressure,
            active: queuePressure === "idle" ? 0 : 128,
            capacity: 128,
          },
        }),
      );
      return;
    }
    if (
      request.url === "/repos/openclaw/repo/issues/1" ||
      request.url === "/repos/openclaw/repo/issues/5"
    ) {
      const number = Number(request.url.split("/").at(-1));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          node_id: `ISSUE_${number}`,
          state: "open",
          number,
          title: `Issue ${number}`,
          body: "changed source",
          locked: false,
          labels: [],
          updated_at: new Date(number === 5 ? 5_000 : number * 1_000 + 60_000).toISOString(),
          repository_url: "https://api.github.com/repos/openclaw/repo",
        }),
      );
      return;
    }
    if (request.url === "/repos/openclaw/repo/issues/2") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          node_id: "ISSUE_2",
          state: "closed",
          number: 2,
          title: "Issue 2",
          body: "closed",
          locked: false,
          labels: [],
          updated_at: new Date(2_000).toISOString(),
          pull_request: {},
          repository_url: "https://api.github.com/repos/openclaw/repo",
        }),
      );
      return;
    }
    if (request.url === "/repos/openclaw/repo/pulls/2") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          head: { sha: "a".repeat(40) },
          base: { sha: "b".repeat(40) },
          draft: false,
          title: "Issue 2",
          body: "closed",
          updated_at: new Date(2_000).toISOString(),
        }),
      );
      return;
    }
    if (request.url === "/repos/gone/repo/issues/3" || request.url === "/repos/gone/repo") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "Not Found" }));
      return;
    }
    const body = Buffer.concat(chunks).toString("utf8");
    const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    assert.equal(request.headers["x-clawsweeper-exact-review-signature"], expected);
    const payload = JSON.parse(body);
    if (request.url?.endsWith("/parked-reviews/list")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, parked_reviews: parkedRows, next_cursor: null }));
      return;
    }
    mutations.push({ url: request.url, payload });
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url?.endsWith("/recover-fresh")) {
      response.end(
        JSON.stringify({
          ok: true,
          recovered: payload.items.length,
          deduped: 0,
          skipped: 0,
        }),
      );
    } else {
      response.end(JSON.stringify({ ok: true, resolved: payload.items.length, skipped: 0 }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const directory = await mkdtemp(join(tmpdir(), "clawsweeper-parked-reconcile-"));
  try {
    const common = [
      "--action",
      "reconcile-parked",
      "--max-targets",
      "100",
      "--max-recoveries",
      "1",
    ];
    const planned = await runOperator(
      [...common, "--output", join(directory, "planned.json")],
      `http://127.0.0.1:${address.port}`,
      secret,
    );
    assert.equal(planned.code, 0, planned.stderr);
    assert.deepEqual(JSON.parse(planned.stdout), {
      action: "reconcile-parked",
      dry_run: true,
      inventory_complete: true,
      queue_pressure: "idle",
      inspected_targets: 4,
      terminal_targets: 2,
      repository_gone_targets: 1,
      resolved_targets: 2,
      open_targets: 2,
      recovered_targets: 1,
      skipped_targets: 2,
      skip_reasons: { unchanged_review_identity: 1 },
      skip_samples: [],
    });
    assert.equal(mutations.length, 0);

    const executed = await runOperator(
      [...common, "--execute", "--output", join(directory, "executed.json")],
      `http://127.0.0.1:${address.port}`,
      secret,
    );
    assert.equal(executed.code, 0, executed.stderr);
    assert.deepEqual(JSON.parse(executed.stdout), {
      action: "reconcile-parked",
      dry_run: false,
      inventory_complete: true,
      queue_pressure: "idle",
      inspected_targets: 4,
      terminal_targets: 2,
      repository_gone_targets: 1,
      resolved_targets: 2,
      open_targets: 2,
      recovered_targets: 1,
      skipped_targets: 2,
      skip_reasons: { unchanged_review_identity: 1 },
      skip_samples: [],
    });
    assert.equal(mutations.filter((entry) => entry.url?.endsWith("/resolve")).length, 2);
    const recovery = mutations.find((entry) => entry.url?.endsWith("/recover-fresh"));
    assert.deepEqual(recovery.payload.items, [
      {
        item_key: "openclaw/repo#1",
        revision: 1,
        updated_at_ms: 1_000,
        source_content_revision: createHash("sha256")
          .update(
            JSON.stringify({
              version: 2,
              title: "Issue 1",
              body: "changed source",
              locked: false,
              close_guard_labels: [],
            }),
          )
          .digest("hex"),
        source_updated_at: new Date(61_000).toISOString(),
      },
    ]);
    assert.match(recovery.payload.idempotency_key, /^parked-reconcile:[a-f0-9]{64}$/);

    queuePressure = "saturated";
    const pressureDeferred = await runOperator(
      [
        "--action",
        "reconcile-parked",
        "--max-targets",
        "100",
        "--max-recoveries",
        "5",
        "--output",
        join(directory, "pressure-deferred.json"),
      ],
      `http://127.0.0.1:${address.port}`,
      secret,
    );
    assert.equal(pressureDeferred.code, 0, pressureDeferred.stderr);
    assert.deepEqual(JSON.parse(pressureDeferred.stdout).skip_reasons, {
      unchanged_review_identity: 1,
      recovery_deferred_pressure: 1,
    });
    assert.equal(JSON.parse(pressureDeferred.stdout).skipped_targets, 3);

    const artifact = JSON.parse(await readFile(join(directory, "executed.json"), "utf8"));
    assert.deepEqual(artifact.summary, {
      rows: 5,
      by_reason: { review_retry_exhausted: 5 },
    });
    assert.equal(
      artifact.parked_reviews.find((row) => row.item_key === "openclaw/repo#4").excluded_reason,
      "command_context",
    );
    assert.equal(JSON.stringify(artifact).includes("test-parked-review-reconcile"), false);

    const overCap = await runOperator(
      ["--action", "reconcile-parked", "--max-recoveries", "6"],
      `http://127.0.0.1:${address.port}`,
      secret,
    );
    assert.equal(overCap.code, 1);
    assert.match(overCap.stderr, /between 0 and 5 for reconcile-parked/);
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("parked pull request reconciliation requires immutable source drift", async () => {
  const secret = "test-parked-review-source-fence";
  const sourceUpdatedAt = "2026-08-10T12:00:00.000Z";
  const title = "Retry fence";
  const body = "unchanged body";
  const sourceContentRevision = createHash("sha256")
    .update(
      JSON.stringify({
        version: 2,
        title,
        body,
        locked: false,
        close_guard_labels: [],
      }),
    )
    .digest("hex");
  const sourceLegacyContentRevision = createHash("sha256")
    .update(JSON.stringify({ version: 1, title, body }))
    .digest("hex");
  let liveUpdatedAt = sourceUpdatedAt;
  let liveLabels: string[] = [];
  const row = {
    ...parkedRow("openclaw/repo#9", "openclaw/repo", 9, 9_000),
    item_kind: "pull_request",
    source_head_sha: "a".repeat(40),
    source_base_sha: "b".repeat(40),
    source_is_draft: false,
    source_content_revision: sourceContentRevision,
    source_updated_at: sourceUpdatedAt,
  };
  let headSha = "a".repeat(40);
  const mutations = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.url === "/api/exact-review-queue") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ pressure: { status: "idle", active: 0, capacity: 128 } }));
      return;
    }
    if (request.url === "/repos/openclaw/repo/issues/9") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          node_id: "PR_9",
          state: "open",
          number: 9,
          title,
          body,
          locked: false,
          labels: liveLabels.map((name) => ({ name })),
          updated_at: liveUpdatedAt,
          pull_request: {},
          repository_url: "https://api.github.com/repos/openclaw/repo",
        }),
      );
      return;
    }
    if (request.url === "/repos/openclaw/repo/pulls/9") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          head: { sha: headSha },
          base: { sha: "b".repeat(40) },
          draft: false,
          title,
          body,
          updated_at: liveUpdatedAt,
        }),
      );
      return;
    }
    const requestBody = Buffer.concat(chunks).toString("utf8");
    const expected = `sha256=${createHmac("sha256", secret).update(requestBody).digest("hex")}`;
    assert.equal(request.headers["x-clawsweeper-exact-review-signature"], expected);
    const payload = JSON.parse(requestBody);
    if (request.url?.endsWith("/parked-reviews/list")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, parked_reviews: [row], next_cursor: null }));
      return;
    }
    mutations.push(payload);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, recovered: 1, deduped: 0, skipped: 0 }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const directory = await mkdtemp(join(tmpdir(), "clawsweeper-parked-source-fence-"));
  const common = ["--action", "reconcile-parked", "--max-targets", "1", "--max-recoveries", "1"];
  try {
    const unchanged = await runOperator(
      [...common, "--output", join(directory, "unchanged.json")],
      `http://127.0.0.1:${address.port}`,
      secret,
    );
    assert.equal(unchanged.code, 0, unchanged.stderr);
    assert.equal(JSON.parse(unchanged.stdout).recovered_targets, 0);
    assert.deepEqual(JSON.parse(unchanged.stdout).skip_reasons, {
      unchanged_review_identity: 1,
    });
    assert.equal(mutations.length, 0);

    liveUpdatedAt = "2026-08-10T12:01:00.000Z";
    const commentOnlyTimestamp = await runOperator(
      [...common, "--output", join(directory, "comment-only-timestamp.json")],
      `http://127.0.0.1:${address.port}`,
      secret,
    );
    assert.equal(commentOnlyTimestamp.code, 0, commentOnlyTimestamp.stderr);
    assert.equal(JSON.parse(commentOnlyTimestamp.stdout).recovered_targets, 0);
    assert.deepEqual(JSON.parse(commentOnlyTimestamp.stdout).skip_reasons, {
      unchanged_review_identity: 1,
    });
    assert.equal(mutations.length, 0);

    liveUpdatedAt = sourceUpdatedAt;
    liveLabels = ["security"];
    const lifecycleChanged = await runOperator(
      [...common, "--execute", "--output", join(directory, "lifecycle-changed.json")],
      `http://127.0.0.1:${address.port}`,
      secret,
    );
    assert.equal(lifecycleChanged.code, 0, lifecycleChanged.stderr);
    assert.equal(JSON.parse(lifecycleChanged.stdout).recovered_targets, 1);
    assert.equal(mutations.length, 1);
    assert.notEqual(mutations[0].items[0].source_content_revision, sourceContentRevision);

    liveLabels = [];
    headSha = "c".repeat(40);
    const changed = await runOperator(
      [...common, "--execute", "--output", join(directory, "changed.json")],
      `http://127.0.0.1:${address.port}`,
      secret,
    );
    assert.equal(changed.code, 0, changed.stderr);
    assert.equal(JSON.parse(changed.stdout).recovered_targets, 1);
    assert.equal(mutations.length, 2);
    assert.equal(mutations[1].items[0].source_head_sha, headSha);
    assert.equal(mutations[1].override_retry_budget, undefined);

    headSha = "a".repeat(40);
    Object.assign(row, {
      source_head_sha: headSha,
      source_base_sha: "b".repeat(40),
      source_is_draft: false,
      source_content_revision: null,
      source_updated_at: liveUpdatedAt,
    });
    const legacyTimestampUnchanged = await runOperator(
      [...common, "--output", join(directory, "legacy-timestamp-unchanged.json")],
      `http://127.0.0.1:${address.port}`,
      secret,
    );
    assert.equal(legacyTimestampUnchanged.code, 0, legacyTimestampUnchanged.stderr);
    assert.equal(JSON.parse(legacyTimestampUnchanged.stdout).recovered_targets, 0);
    assert.deepEqual(JSON.parse(legacyTimestampUnchanged.stdout).skip_reasons, {
      unchanged_review_identity: 1,
    });
    assert.equal(mutations.length, 2);

    row.source_content_revision = sourceLegacyContentRevision;
    const legacyDigestUnchanged = await runOperator(
      [...common, "--output", join(directory, "legacy-digest-unchanged.json")],
      `http://127.0.0.1:${address.port}`,
      secret,
    );
    assert.equal(legacyDigestUnchanged.code, 0, legacyDigestUnchanged.stderr);
    assert.equal(JSON.parse(legacyDigestUnchanged.stdout).recovered_targets, 0);
    assert.deepEqual(JSON.parse(legacyDigestUnchanged.stdout).skip_reasons, {
      unchanged_review_identity: 1,
    });
    assert.equal(mutations.length, 2);

    Object.assign(row, {
      source_head_sha: null,
      source_base_sha: null,
      source_is_draft: null,
      source_content_revision: null,
      source_updated_at: null,
    });
    headSha = "d".repeat(40);
    const legacyHydrated = await runOperator(
      [...common, "--execute", "--output", join(directory, "legacy-hydrated.json")],
      `http://127.0.0.1:${address.port}`,
      secret,
    );
    assert.equal(legacyHydrated.code, 0, legacyHydrated.stderr);
    assert.equal(JSON.parse(legacyHydrated.stdout).recovered_targets, 1);
    assert.equal(mutations.length, 3);
    assert.equal(mutations[2].items[0].source_head_sha, headSha);
    assert.equal(mutations[2].items[0].source_base_sha, "b".repeat(40));
    assert.equal(mutations[2].items[0].source_is_draft, false);
    assert.equal(mutations[2].items[0].source_updated_at, liveUpdatedAt);
    assert.equal(mutations[2].items[0].source_content_revision, sourceContentRevision);

    headSha = "a".repeat(40);
    Object.assign(row, {
      source_head_sha: headSha,
      source_base_sha: "b".repeat(40),
      source_is_draft: false,
      source_content_revision: sourceContentRevision,
      source_updated_at: sourceUpdatedAt,
    });
    const forced = await runOperator(
      [...common, "--execute", "--force-unchanged", "--output", join(directory, "forced.json")],
      `http://127.0.0.1:${address.port}`,
      secret,
    );
    assert.equal(forced.code, 0, forced.stderr);
    assert.equal(JSON.parse(forced.stdout).recovered_targets, 1);
    assert.equal(mutations.length, 4);
    assert.equal(mutations[3].override_retry_budget, true);
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("parked review reconciliation reports bounded HTTP and timeout skip diagnostics", async () => {
  const secret = "test-parked-review-skip-reasons";
  const parkedRows = [
    parkedRow("openclaw/repo#1", "openclaw/repo", 1, 1_000),
    parkedRow("openclaw/repo#2", "openclaw/repo", 2, 2_000),
    parkedRow("openclaw/repo#3", "openclaw/repo", 3, 3_000),
    parkedRow("openclaw/repo#4", "openclaw/repo", 4, 4_000),
  ];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.url === "/api/exact-review-queue") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ pressure: { status: "idle", active: 0, capacity: 128 } }));
      return;
    }
    if (request.url === "/repos/openclaw/repo/issues/1") {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "Resource not accessible by integration" }));
      return;
    }
    const body = Buffer.concat(chunks).toString("utf8");
    const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    assert.equal(request.headers["x-clawsweeper-exact-review-signature"], expected);
    assert.ok(request.url?.endsWith("/parked-reviews/list"));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, parked_reviews: parkedRows, next_cursor: null }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const directory = await mkdtemp(join(tmpdir(), "clawsweeper-parked-skip-reasons-"));
  try {
    const preloadPath = join(directory, "timeout-fetch.mjs");
    await writeFile(
      preloadPath,
      `const nativeFetch = globalThis.fetch;\n` +
        `globalThis.fetch = (input, init) => /\\/issues\\/[2-4]$/.test(String(input))\n` +
        `  ? Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"))\n` +
        `  : nativeFetch(input, init);\n`,
      "utf8",
    );
    const result = await runOperator(
      [
        "--action",
        "reconcile-parked",
        "--max-targets",
        "100",
        "--output",
        join(directory, "inventory.json"),
      ],
      `http://127.0.0.1:${address.port}`,
      secret,
      { NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}` },
    );
    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.deepEqual(summary.skip_reasons, { http_403: 1, timeout: 3 });
    assert.deepEqual(summary.skip_samples, [
      {
        target: "openclaw/repo#1",
        reason:
          "parked review target check failed for openclaw/repo#1 with 403: Resource not accessible by integration",
      },
      {
        target: "openclaw/repo#2",
        reason: "The operation was aborted due to timeout",
      },
      {
        target: "openclaw/repo#3",
        reason: "The operation was aborted due to timeout",
      },
    ]);
    assert.equal(summary.inspected_targets, 4);
    assert.equal(summary.skipped_targets, 4);
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("parked review reconciliation stops safely at the workflow deadline", async () => {
  const secret = "test-parked-review-deadline";
  const parkedRows = [
    parkedRow("openclaw/repo#1", "openclaw/repo", 1, 1_000),
    parkedRow("openclaw/repo#2", "openclaw/repo", 2, 2_000),
    parkedRow("openclaw/repo#3", "openclaw/repo", 3, 3_000),
  ];
  const targetRequests: string[] = [];
  const targetClosed = Promise.withResolvers<{ aborted: boolean; elapsedMs: number }>();
  let mutations = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.url === "/api/exact-review-queue") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ pressure: { status: "idle", active: 0, capacity: 128 } }));
      return;
    }
    if (request.url?.startsWith("/repos/openclaw/repo/issues/")) {
      targetRequests.push(request.url);
      const startedAt = Date.now();
      const timer = setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ node_id: "ISSUE_DELAYED", state: "open", number: 1 }));
      }, 5_000);
      response.once("close", () => {
        clearTimeout(timer);
        targetClosed.resolve({
          aborted: !response.writableEnded,
          elapsedMs: Date.now() - startedAt,
        });
      });
      return;
    }
    const body = Buffer.concat(chunks).toString("utf8");
    const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    assert.equal(request.headers["x-clawsweeper-exact-review-signature"], expected);
    if (request.url?.endsWith("/parked-reviews/list")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, parked_reviews: parkedRows, next_cursor: null }));
      return;
    }
    mutations += 1;
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unexpected_mutation" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const directory = await mkdtemp(join(tmpdir(), "clawsweeper-parked-deadline-"));
  try {
    const preloadPath = join(directory, "deadline-clock.mjs");
    const abortTracePath = join(directory, "target-abort.txt");
    // Preparation must not consume the scenario's deadline. Advance the clock
    // only when the real target request's native timeout fires.
    await writeFile(
      preloadPath,
      `import { writeFileSync } from "node:fs";
const deadlineAt = Number(process.env.EXACT_REVIEW_RECONCILE_DEADLINE_MS);
let now = deadlineAt - 1_000;
Date.now = () => now;
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (new URL(input).pathname === "/repos/openclaw/repo/issues/1") {
    init.signal.addEventListener("abort", () => {
      now = deadlineAt;
      writeFileSync(${JSON.stringify(abortTracePath)}, init.signal.reason.name);
    }, { once: true });
  }
  return nativeFetch(input, init);
};
`,
      "utf8",
    );
    const result = await runOperator(
      [
        "--action",
        "reconcile-parked",
        "--execute",
        "--max-targets",
        "100",
        "--output",
        join(directory, "deadline.json"),
      ],
      `http://127.0.0.1:${address.port}`,
      secret,
      {
        EXACT_REVIEW_RECONCILE_DEADLINE_MS: String(Date.now() + 1_000),
        NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}`,
      },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(targetRequests, ["/repos/openclaw/repo/issues/1"]);
    const closed = await targetClosed.promise;
    assert.equal(closed.aborted, true);
    assert.ok(closed.elapsedMs < 2_500, "hung target request exceeded the deadline bound");
    assert.equal(await readFile(abortTracePath, "utf8"), "TimeoutError");
    assert.deepEqual(JSON.parse(result.stdout), {
      action: "reconcile-parked",
      dry_run: false,
      inventory_complete: true,
      queue_pressure: "idle",
      inspected_targets: 1,
      terminal_targets: 0,
      repository_gone_targets: 0,
      resolved_targets: 0,
      open_targets: 0,
      recovered_targets: 0,
      skipped_targets: 3,
      skip_reasons: {},
      skip_samples: [],
      deadline_reached: true,
    });
    assert.equal(mutations, 0);
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("automatic reconciliation resolves terminal rows and recovers one fresh review per target", async () => {
  const secret = "test-automatic-dead-letter-secret";
  const mutations = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.url === "/api/exact-review-queue") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ pressure: { status: "idle", active: 0, capacity: 128 } }));
      return;
    }
    if (request.url?.startsWith("/repos/openclaw/repo/issues/")) {
      const number = Number(request.url.split("/").at(-1));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ node_id: `ISSUE_${number}`, state: number === 2 ? "closed" : "open" }),
      );
      return;
    }
    const body = Buffer.concat(chunks).toString("utf8");
    const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    assert.equal(request.headers["x-clawsweeper-exact-review-signature"], expected);
    const payload = JSON.parse(body);
    if (request.url?.endsWith("/list")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          dead_letters: [
            row(
              "invalid",
              "publication:invalid",
              1,
              "tuple_protocol_invalid",
              false,
              "invalid_dead_letter_item",
              null,
            ),
            row(
              "closed-a",
              "publication:closed-a",
              1,
              "retry_exhausted",
              true,
              "eligible",
              "openclaw/repo#2",
            ),
            row(
              "closed-b",
              "publication:closed-b",
              2,
              "retry_exhausted",
              true,
              "eligible",
              "OpenClaw/Repo#2",
            ),
            row(
              "open-a",
              "publication:open-a",
              3,
              "retry_exhausted",
              true,
              "eligible",
              "openclaw/repo#1",
            ),
            row(
              "open-b",
              "publication:open-b",
              4,
              "retry_exhausted",
              true,
              "eligible",
              "OpenClaw/Repo#1",
            ),
            row(
              "active",
              "publication:active",
              5,
              "retry_exhausted",
              false,
              "fresh_review_already_active",
              "openclaw/repo#3",
            ),
          ],
          next_cursor: null,
        }),
      );
      return;
    }
    mutations.push({ url: request.url, payload });
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url?.endsWith("/recover-fresh")) {
      response.end(JSON.stringify({ ok: true, recovered: 1, deduped: 0, skipped: 0, unparked: 0 }));
    } else {
      response.end(
        JSON.stringify({ ok: true, resolved: payload.ids.length, skipped: 0, unparked: 0 }),
      );
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const directory = await mkdtemp(join(tmpdir(), "clawsweeper-dlq-auto-"));
  try {
    const args = [
      "--action",
      "reconcile",
      "--max-targets",
      "8",
      "--max-recoveries",
      "2",
      "--execute",
      "--output",
      join(directory, "inventory.json"),
    ];
    const result = await runOperator(args, `http://127.0.0.1:${address.port}`, secret);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      action: "reconcile",
      dry_run: false,
      inventory_complete: true,
      queue_pressure: "idle",
      inspected_targets: 2,
      recovered_targets: 1,
      resolved_rows: 5,
      supersession_checked_targets: 0,
      superseded_targets: 0,
      superseded_rows: 0,
      invalid_rows: 1,
      closed_rows: 2,
      duplicate_rows: 1,
      active_review_rows: 0,
      skipped_targets: 1,
      skip_reasons: { active_work: 1 },
      skip_samples: [
        {
          target: "openclaw/repo#3",
          reason: "canonical target has active review or publication work",
        },
      ],
    });
    const recovery = mutations.filter((entry) => entry.url?.endsWith("/recover-fresh"));
    assert.equal(recovery.length, 1);
    assert.deepEqual(recovery[0].payload.ids, ["open-a"]);
    assert.match(recovery[0].payload.idempotency_key, /^autoreconcile:[a-f0-9]{64}$/);
    assert.match(recovery[0].payload.inventory_fingerprint, /^\d+:[a-f0-9]{8}$/);
    assert.deepEqual(recovery[0].payload.recovery_aliases, [
      { id: "open-a", aliases: ["openclaw/repo#1"] },
    ]);
    assert.deepEqual(recovery[0].payload.recovery_targets, [
      { id: "open-a", target: "openclaw/repo#1" },
    ]);
    assert.equal(
      mutations.some((entry) => entry.url?.includes("/replay")),
      false,
    );
    assert.ok(mutations.some((entry) => entry.payload.ids.includes("closed-a")));
    assert.ok(mutations.some((entry) => entry.payload.ids.includes("open-b")));
    assert.equal(
      mutations.some((entry) => entry.payload.ids.includes("active")),
      false,
    );
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("automatic reconciliation skips fresh recovery under pressure and enforces hard caps", async () => {
  const secret = "test-automatic-dead-letter-pressure";
  let recoveries = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/api/exact-review-queue") {
      response.end(
        JSON.stringify({ pressure: { status: "saturated", active: 128, capacity: 128 } }),
      );
    } else if (request.url?.startsWith("/repos/")) {
      response.end(JSON.stringify({ node_id: "ISSUE_1", state: "open" }));
    } else if (request.url?.endsWith("/recover-fresh")) {
      recoveries += 1;
      response.end(JSON.stringify({ ok: true, recovered: 1, deduped: 0, skipped: 0, unparked: 0 }));
    } else {
      response.end(
        JSON.stringify({
          ok: true,
          dead_letters: [
            row(
              "one",
              "publication:one",
              1,
              "retry_exhausted",
              true,
              "eligible",
              "openclaw/repo#1",
            ),
          ],
          next_cursor: null,
        }),
      );
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const result = await runOperator(
      ["--action", "reconcile", "--execute"],
      `http://127.0.0.1:${address.port}`,
      secret,
    );
    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.queue_pressure, "saturated");
    assert.equal(summary.recovered_targets, 0);
    assert.deepEqual(summary.skip_reasons, { recovery_deferred_pressure: 1 });
    assert.equal(recoveries, 0);
    for (const [flag, value] of [
      ["--max-targets", "0"],
      ["--max-targets", "101"],
      ["--max-recoveries", "11"],
      ["--max-recoveries", "-1"],
    ]) {
      const rejected = await runOperator(
        ["--action", "reconcile", flag, value],
        `http://127.0.0.1:${address.port}`,
        secret,
      );
      assert.equal(rejected.code, 1);
      assert.match(rejected.stderr, /must be between/);
    }
  } finally {
    server.close();
  }
});

test("automatic recovery rechecks authoritative pressure and deduplicates canonical GitHub identities", async () => {
  const stale = await automaticReconcileScenario({
    rows: [
      row("stale", "publication:stale", 1, "retry_exhausted", true, "eligible", "openclaw/repo#1"),
    ],
    stalePressure: true,
  });
  assert.equal(stale.first.code, 0, stale.first.stderr);
  assert.equal(stale.recoveries.length, 0);
  assert.equal(JSON.parse(stale.first.stdout).queue_pressure, "unknown");

  const changingPressure = await automaticReconcileScenario({
    rows: [
      row("first", "publication:first", 1, "retry_exhausted", true, "eligible", "openclaw/repo#1"),
      row(
        "second",
        "publication:second",
        1,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#2",
      ),
    ],
    pressure: (recoveries) => (recoveries > 0 ? "saturated" : "idle"),
    nodeId: (number) => `ISSUE_${number}`,
  });
  assert.equal(changingPressure.first.code, 0, changingPressure.first.stderr);
  assert.equal(changingPressure.recoveries.length, 1);
  assert.equal(JSON.parse(changingPressure.first.stdout).queue_pressure, "idle");

  const aliased = await automaticReconcileScenario({
    rows: [
      row("old", "publication:old", 1, "retry_exhausted", true, "eligible", "openclaw/old#7"),
      row("new", "publication:new", 1, "retry_exhausted", true, "eligible", "openclaw/new#7"),
    ],
    nodeId: () => "ISSUE_CANONICAL_7",
  });
  assert.equal(aliased.first.code, 0, aliased.first.stderr);
  assert.equal(aliased.recoveries.length, 1);
  assert.equal(JSON.parse(aliased.first.stdout).duplicate_rows, 1);
});

test("duplicate cleanup finishes before target-scoped recovery and safely resumes after failure", async () => {
  const failedCleanup = await automaticReconcileScenario({
    rows: [
      row(
        "primary",
        "publication:primary",
        1,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#9",
      ),
      row(
        "duplicate",
        "publication:duplicate",
        2,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#9",
      ),
    ],
    failFirstDuplicateCleanup: true,
    repeat: true,
  });
  assert.equal(failedCleanup.first.code, 1);
  assert.equal(failedCleanup.second?.code, 0, failedCleanup.second?.stderr);
  assert.equal(failedCleanup.recoveries.length, 1);
  assert.deepEqual(failedCleanup.recoveries[0]?.ids, ["primary"]);

  const manyDuplicates = await automaticReconcileScenario({
    rows: Array.from({ length: 23 }, (_, index) =>
      row(
        `row-${String(index).padStart(2, "0")}`,
        `publication:${index}`,
        index + 1,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#10",
      ),
    ),
    repeat: true,
  });
  assert.equal(manyDuplicates.first.code, 0, manyDuplicates.first.stderr);
  assert.equal(JSON.parse(manyDuplicates.first.stdout).recovered_targets, 0);
  assert.equal(manyDuplicates.second?.code, 0, manyDuplicates.second?.stderr);
  assert.equal(manyDuplicates.recoveries.length, 1);
  assert.deepEqual(manyDuplicates.recoveries[0]?.ids, ["row-00"]);
});

test("concurrent duplicate cleanup refreshes inventory before safe recovery", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [
      row(
        "primary",
        "publication:primary",
        1,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#9",
      ),
      row(
        "duplicate",
        "publication:duplicate",
        2,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#9",
      ),
    ],
    skipFirstDuplicateCleanup: true,
    repeat: true,
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  assert.equal(JSON.parse(scenario.first.stdout).recovered_targets, 1);
  assert.ok(scenario.inventoryRequests >= 3);
  assert.equal(scenario.second?.code, 0, scenario.second?.stderr);
  assert.equal(scenario.recoveries.length, 1);
  assert.deepEqual(scenario.recoveries[0]?.ids, ["primary"]);
});

test("an unchanged blocked cleanup cannot starve independent fresh recovery", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [
      row(
        "blocked",
        "publication:blocked",
        1,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#1",
      ),
      row(
        "recoverable",
        "publication:recoverable",
        2,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#2",
      ),
    ],
    closedNumbers: [1],
    blockedCleanupIds: ["blocked"],
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  assert.doesNotMatch(scenario.first.stderr, /reconcile_skip_accounting_inconsistent/);
  const summary = JSON.parse(scenario.first.stdout);
  assert.equal(summary.inspected_targets, 2);
  assert.equal(summary.recovered_targets, 1);
  assert.equal(summary.skipped_targets, 1);
  assert.equal(scenario.inventoryRequests, 2);
  assert.deepEqual(
    scenario.resolutions.map((resolution) => resolution.ids),
    [["blocked"]],
  );
  assert.deepEqual(
    scenario.recoveries.map((recovery) => recovery.ids),
    [["recoverable"]],
  );
});

test("a blocked targetless legacy row cannot starve independent fresh recovery", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [
      row(
        "legacy-blocked",
        "publication:legacy-blocked",
        1,
        "tuple_protocol_invalid",
        false,
        "invalid_dead_letter_item",
        null,
      ),
      row(
        "recoverable",
        "publication:recoverable",
        2,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#2",
      ),
    ],
    blockedCleanupIds: ["legacy-blocked"],
    maxTargets: 1,
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  const summary = JSON.parse(scenario.first.stdout);
  assert.equal(summary.inspected_targets, 1);
  assert.equal(summary.recovered_targets, 1);
  assert.equal(summary.invalid_rows, 0);
  assert.equal(scenario.inventoryRequests, 2);
  assert.deepEqual(
    scenario.resolutions.map((resolution) => resolution.ids),
    [["legacy-blocked"]],
  );
  assert.deepEqual(
    scenario.recoveries.map((recovery) => recovery.ids),
    [["recoverable"]],
  );
});

test("many blocked targetless legacy rows cannot exhaust the inventory refresh budget", async () => {
  const blocked = Array.from({ length: 60 }, (_, index) =>
    row(
      `legacy-${index}`,
      `publication:legacy-${index}`,
      index + 1,
      "tuple_protocol_invalid",
      false,
      "invalid_dead_letter_item",
      null,
    ),
  );
  const scenario = await automaticReconcileScenario({
    rows: [
      ...blocked,
      row(
        "recoverable",
        "publication:recoverable",
        61,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#2",
      ),
    ],
    blockedCleanupIds: blocked.map((entry) => entry.dead_letter_id),
    maxTargets: 1,
    maxRecoveries: 1,
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  const summary = JSON.parse(scenario.first.stdout);
  assert.equal(summary.inspected_targets, 1);
  assert.equal(summary.recovered_targets, 1);
  assert.equal(scenario.inventoryRequests, 2);
  assert.equal(scenario.resolutions.length, 1);
  assert.equal(scenario.resolutions[0]?.ids.length, 20);
  assert.deepEqual(
    scenario.recoveries.map((recovery) => recovery.ids),
    [["recoverable"]],
  );
});

test("multiple independently blocked groups share one authoritative refresh", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [
      ...Array.from({ length: 3 }, (_, index) =>
        row(
          `blocked-${index + 1}`,
          `publication:blocked-${index + 1}`,
          index + 1,
          "retry_exhausted",
          true,
          "eligible",
          `openclaw/repo#${index + 1}`,
        ),
      ),
      row(
        "recoverable",
        "publication:recoverable",
        4,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#4",
      ),
    ],
    closedNumbers: [1, 2, 3],
    blockedCleanupIds: ["blocked-1", "blocked-2", "blocked-3"],
    maxTargets: 4,
    maxRecoveries: 1,
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  const summary = JSON.parse(scenario.first.stdout);
  assert.equal(summary.inspected_targets, 4);
  assert.equal(summary.recovered_targets, 1);
  assert.equal(summary.skipped_targets, 3);
  assert.equal(scenario.inventoryRequests, 2);
  assert.deepEqual(
    scenario.resolutions.map((resolution) => resolution.ids),
    [["blocked-1"], ["blocked-2"], ["blocked-3"]],
  );
  assert.deepEqual(
    scenario.recoveries.map((recovery) => recovery.ids),
    [["recoverable"]],
  );
});

test("blocked canonical targets are counted only once across inventory refreshes", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [
      ...Array.from({ length: 2 }, (_, index) =>
        row(
          `blocked-${index + 1}`,
          `publication:blocked-${index + 1}`,
          index + 1,
          "retry_exhausted",
          true,
          "eligible",
          `openclaw/repo#${index + 1}`,
        ),
      ),
      row(
        "recoverable",
        "publication:recoverable",
        3,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#3",
      ),
    ],
    closedNumbers: [1, 2],
    blockedCleanupIds: ["blocked-1", "blocked-2"],
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  const summary = JSON.parse(scenario.first.stdout);
  assert.equal(summary.inspected_targets, 3);
  assert.equal(summary.recovered_targets, 1);
  assert.equal(summary.skipped_targets, 2);
  assert.equal(scenario.inventoryRequests, 2);
});

test("active and capped targets are counted only once across blocked inventory refreshes", async () => {
  for (const active of [true, false]) {
    const scenario = await automaticReconcileScenario({
      rows: [
        row(
          "blocked",
          "publication:blocked",
          1,
          "retry_exhausted",
          true,
          "eligible",
          "openclaw/repo#1",
        ),
        row(
          "recoverable",
          "publication:recoverable",
          2,
          "retry_exhausted",
          true,
          "eligible",
          "openclaw/repo#2",
        ),
        row(
          "deferred",
          "publication:deferred",
          3,
          "retry_exhausted",
          !active,
          active ? "fresh_review_already_active" : "eligible",
          "openclaw/repo#3",
        ),
      ],
      closedNumbers: [1],
      blockedCleanupIds: ["blocked"],
      maxTargets: 3,
      maxRecoveries: 1,
    });

    assert.equal(scenario.first.code, 0, scenario.first.stderr);
    const summary = JSON.parse(scenario.first.stdout);
    assert.equal(summary.recovered_targets, 1);
    assert.equal(summary.skipped_targets, 2);
    assert.deepEqual(
      summary.skip_reasons,
      active ? { blocked_alias: 1, active_work: 1 } : { blocked_alias: 1, recovery_cap: 1 },
    );
    assert.equal(scenario.inventoryRequests, 2);
  }
});

test("staged recovery retains its original target budget across a blocked refresh", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [
      row(
        "blocked",
        "publication:blocked",
        1,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#1",
      ),
      row(
        "recoverable",
        "publication:recoverable",
        2,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#2",
      ),
      row(
        "over-budget",
        "publication:over-budget",
        3,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#3",
      ),
    ],
    closedNumbers: [1],
    blockedCleanupIds: ["blocked"],
    maxTargets: 2,
    maxRecoveries: 1,
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  const summary = JSON.parse(scenario.first.stdout);
  assert.equal(summary.inspected_targets, 2);
  assert.equal(summary.recovered_targets, 1);
  assert.equal(scenario.inventoryRequests, 2);
  assert.deepEqual(
    scenario.recoveries.map((recovery) => recovery.ids),
    [["recoverable"]],
  );
});

test("blocked duplicate cleanup fences its primary without starving another target", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [
      row(
        "blocked-primary",
        "publication:blocked-primary",
        1,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#1",
      ),
      row(
        "blocked-duplicate",
        "publication:blocked-duplicate",
        2,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#1",
      ),
      row(
        "recoverable",
        "publication:recoverable",
        3,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#2",
      ),
    ],
    blockedCleanupIds: ["blocked-duplicate"],
    maxTargets: 2,
    maxRecoveries: 1,
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  const summary = JSON.parse(scenario.first.stdout);
  assert.equal(summary.inspected_targets, 2);
  assert.equal(summary.recovered_targets, 1);
  assert.equal(summary.skipped_targets, 1);
  assert.equal(scenario.inventoryRequests, 2);
  assert.deepEqual(
    scenario.recoveries.map((recovery) => recovery.ids),
    [["recoverable"]],
  );
});

test("only unchanged blocked groups fence aliases after an aggregated refresh", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [
      row(
        "blocked",
        "publication:blocked",
        1,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#1",
      ),
      row(
        "primary",
        "publication:primary",
        2,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#2",
      ),
      row(
        "duplicate",
        "publication:duplicate",
        3,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#2",
      ),
      row(
        "recoverable",
        "publication:recoverable",
        4,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#3",
      ),
    ],
    closedNumbers: [1],
    blockedCleanupIds: ["blocked"],
    skipDuplicateCleanupCount: 1,
    maxTargets: 3,
    maxRecoveries: 2,
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  const summary = JSON.parse(scenario.first.stdout);
  assert.equal(summary.inspected_targets, 3);
  assert.equal(summary.recovered_targets, 2);
  assert.equal(summary.skipped_targets, 1);
  assert.equal(scenario.inventoryRequests, 2);
  assert.deepEqual(
    scenario.resolutions.map((resolution) => resolution.ids),
    [["blocked"], ["duplicate"]],
  );
  assert.deepEqual(
    scenario.recoveries.map((recovery) => recovery.ids),
    [["primary", "recoverable"]],
  );
});

test("a blocked transferred alias fences its whole target without starving another", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [
      row(
        "blocked-old",
        "publication:blocked-old",
        1,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/old#1",
      ),
      row(
        "blocked-new",
        "publication:blocked-new",
        2,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/new#19",
      ),
      row(
        "recoverable",
        "publication:recoverable",
        3,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#2",
      ),
    ],
    closedNumbers: [1, 19],
    blockedCleanupIds: ["blocked-old"],
    nodeId: (number) => (number === 2 ? "INDEPENDENT" : "BLOCKED_TRANSFER"),
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  assert.equal(JSON.parse(scenario.first.stdout).recovered_targets, 1);
  assert.deepEqual(
    scenario.recoveries.map((recovery) => recovery.ids),
    [["recoverable"]],
  );
  assert.equal(scenario.resolutions.length, 1);
});

test("reconciliation rejects a non-atomic guarded cleanup response", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [
      row(
        "primary",
        "publication:primary",
        1,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#1",
      ),
      row(
        "duplicate-a",
        "publication:duplicate-a",
        2,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#1",
      ),
      row(
        "duplicate-b",
        "publication:duplicate-b",
        3,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#1",
      ),
    ],
    nonAtomicFirstCleanup: true,
  });

  assert.equal(scenario.first.code, 1);
  assert.match(scenario.first.stderr, /guarded dead-letter cleanup was not atomic/);
  assert.equal(scenario.inventoryRequests, 1);
  assert.equal(scenario.recoveries.length, 0);
});

test("reconciliation rejects a malformed zero-mutation guarded cleanup response", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [
      row(
        "blocked",
        "publication:blocked",
        1,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#1",
      ),
      row(
        "recoverable",
        "publication:recoverable",
        2,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#2",
      ),
    ],
    closedNumbers: [1],
    malformedGuardIds: ["blocked"],
  });

  assert.equal(scenario.first.code, 1);
  assert.match(scenario.first.stderr, /guarded dead-letter cleanup was not atomic/);
  assert.equal(scenario.inventoryRequests, 1);
  assert.equal(scenario.recoveries.length, 0);
});

test("independent cleanup races refresh once before recovering current aliases", async () => {
  const rows = Array.from({ length: 3 }, (_, index) => [
    row(
      `primary-${index}`,
      `publication:primary-${index}`,
      index * 2 + 1,
      "retry_exhausted",
      true,
      "eligible",
      `openclaw/repo#${index + 1}`,
    ),
    row(
      `duplicate-${index}`,
      `publication:duplicate-${index}`,
      index * 2 + 2,
      "retry_exhausted",
      true,
      "eligible",
      `openclaw/repo#${index + 1}`,
    ),
  ]).flat();
  const scenario = await automaticReconcileScenario({
    rows,
    skipDuplicateCleanupCount: 3,
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  const summary = JSON.parse(scenario.first.stdout);
  assert.equal(summary.recovered_targets, 3);
  assert.equal(summary.inspected_targets, 3);
  assert.equal(scenario.inventoryRequests, 2);
  assert.deepEqual(
    scenario.resolutions.map((resolution) => resolution.ids),
    [["duplicate-0"], ["duplicate-1"], ["duplicate-2"]],
  );
  assert.deepEqual(
    scenario.recoveries.map((recovery) => recovery.ids),
    [["primary-0", "primary-1", "primary-2"]],
  );
});

test("inventory refreshes preserve the original per-run target budget", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [
      row(
        "closed-one",
        "publication:closed-one",
        1,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#1",
      ),
      row(
        "closed-two",
        "publication:closed-two",
        2,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#2",
      ),
    ],
    closedNumbers: [1, 2],
    maxTargets: 1,
    skipFirstDuplicateCleanup: true,
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  assert.equal(JSON.parse(scenario.first.stdout).inspected_targets, 1);
  assert.equal(JSON.parse(scenario.first.stdout).inventory_changed, true);
  assert.deepEqual(
    scenario.resolutions.map((resolution) => resolution.ids),
    [["closed-one"]],
  );
});

test("inventory refreshes preserve cleanup counters when later target discovery fails", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [
      row(
        "closed-one",
        "publication:closed-one",
        1,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#1",
      ),
      row(
        "closed-two",
        "publication:closed-two",
        2,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#2",
      ),
      row(
        "open-three",
        "publication:open-three",
        3,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#3",
      ),
      row(
        "invalid",
        "publication:invalid",
        4,
        "tuple_protocol_invalid",
        false,
        "invalid_dead_letter_item",
        null,
      ),
    ],
    closedNumbers: [1, 2],
    skipCleanupAtResolution: 2,
    failTargetAfterCleanup: 3,
    maxTargets: 3,
    maxRecoveries: 1,
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  const summary = JSON.parse(scenario.first.stdout);
  assert.equal(summary.resolved_rows, 2);
  assert.equal(summary.closed_rows, 1);
  assert.equal(summary.invalid_rows, 1);
  assert.equal(scenario.inventoryRequests, 2);
  assert.deepEqual(
    scenario.resolutions.map((resolution) => resolution.ids),
    [["closed-one"], ["closed-two"], ["invalid"]],
  );
});

test("automatic recovery rechecks pressure immediately after duplicate cleanup", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [
      row(
        "primary",
        "publication:primary",
        1,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#1",
      ),
      row(
        "duplicate",
        "publication:duplicate",
        2,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#1",
      ),
    ],
    pressure: (_recoveries, resolutions) => (resolutions > 0 ? "saturated" : "idle"),
  });
  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  assert.equal(JSON.parse(scenario.first.stdout).queue_pressure, "saturated");
  assert.equal(scenario.resolutions.length, 1);
  assert.equal(scenario.recoveries.length, 0);
});

test("renamed aliases are grouped before recovery and active siblings block every alias", async () => {
  const cleanupFailure = await automaticReconcileScenario({
    rows: [
      row("old", "publication:old", 1, "retry_exhausted", true, "eligible", "openclaw/old#7"),
      row("new", "publication:new", 2, "retry_exhausted", true, "eligible", "openclaw/new#7"),
    ],
    nodeId: () => "ISSUE_CANONICAL_7",
    failFirstDuplicateCleanup: true,
    repeat: true,
  });
  assert.equal(cleanupFailure.first.code, 1);
  assert.equal(cleanupFailure.second?.code, 0, cleanupFailure.second?.stderr);
  assert.equal(cleanupFailure.recoveries.length, 1);
  assert.deepEqual(cleanupFailure.recoveries[0]?.ids, ["old"]);

  const activeAlias = await automaticReconcileScenario({
    rows: [
      row(
        "active",
        "publication:active",
        1,
        "retry_exhausted",
        false,
        "fresh_review_already_active",
        "openclaw/old#7",
      ),
      row(
        "eligible",
        "publication:eligible",
        2,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/new#7",
      ),
    ],
    nodeId: () => "ISSUE_CANONICAL_7",
  });
  assert.equal(activeAlias.first.code, 0, activeAlias.first.stderr);
  assert.equal(activeAlias.recoveries.length, 0);
  assert.equal(JSON.parse(activeAlias.first.stdout).active_review_rows, 0);
  assert.equal(activeAlias.resolutions.length, 0);
});

test("active publication siblings block recovery beyond the first resolution page", async () => {
  const scenario = await automaticReconcileScenario({
    rows: Array.from({ length: 21 }, (_, index) =>
      row(
        `row-${String(index).padStart(2, "0")}`,
        `publication:${index}`,
        index + 1,
        "retry_exhausted",
        index === 20,
        index === 20 ? "eligible" : "publication_item_active",
        "openclaw/repo#12",
      ),
    ),
  });
  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  assert.equal(scenario.recoveries.length, 0);
  assert.equal(JSON.parse(scenario.first.stdout).active_review_rows, 0);
});

test("automatic recovery refuses aliases omitted by caps or failed GitHub checks", async () => {
  const capped = await automaticReconcileScenario({
    rows: [
      row(
        "eligible",
        "publication:eligible",
        1,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/old#7",
      ),
      row(
        "active",
        "publication:active",
        2,
        "retry_exhausted",
        false,
        "fresh_review_already_active",
        "openclaw/new#7",
      ),
    ],
    maxTargets: 1,
    nodeId: () => "ISSUE_CANONICAL_7",
  });
  assert.equal(capped.first.code, 0, capped.first.stderr);
  assert.equal(capped.recoveries.length, 0);
  assert.equal(capped.resolutions.length, 0);

  const transferred = await automaticReconcileScenario({
    rows: [
      row(
        "eligible",
        "publication:eligible",
        1,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/old#7",
      ),
      row(
        "active",
        "publication:active",
        2,
        "retry_exhausted",
        false,
        "fresh_review_already_active",
        "openclaw/new#19",
      ),
    ],
    maxTargets: 1,
    nodeId: () => "ISSUE_CANONICAL_TRANSFERRED",
  });
  assert.equal(transferred.first.code, 0, transferred.first.stderr);
  assert.equal(transferred.recoveries.length, 0);
  assert.equal(transferred.resolutions.length, 0);

  const unresolved = await automaticReconcileScenario({
    rows: [
      row(
        "eligible",
        "publication:eligible",
        1,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/old#7",
      ),
      row(
        "active",
        "publication:active",
        2,
        "retry_exhausted",
        false,
        "fresh_review_already_active",
        "openclaw/new#19",
      ),
    ],
    nodeId: () => "ISSUE_CANONICAL_7",
    failedRepository: "new",
  });
  assert.equal(unresolved.first.code, 0, unresolved.first.stderr);
  assert.equal(unresolved.recoveries.length, 0);
  assert.equal(unresolved.resolutions.length, 0);
});

test("bounded canonical discovery deduplicates transferred eligible aliases", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [
      row("old", "publication:old", 1, "retry_exhausted", true, "eligible", "openclaw/old#7"),
      row("new", "publication:new", 2, "retry_exhausted", true, "eligible", "openclaw/new#19"),
    ],
    maxTargets: 1,
    nodeId: () => "ISSUE_TRANSFERRED",
  });
  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  assert.deepEqual(scenario.resolutions[0]?.ids, ["new"]);
  assert.deepEqual(scenario.recoveries[0]?.ids, ["old"]);
});

test("incomplete bounded inventories drain invalid rows without recovering unknown aliases", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [
      row(
        "invalid",
        "publication:invalid",
        1,
        "tuple_protocol_invalid",
        false,
        "invalid_dead_letter_item",
        null,
      ),
      ...Array.from({ length: 5000 }, (_, index) =>
        row(
          `eligible-${index}`,
          `publication:${index}`,
          index + 1,
          "retry_exhausted",
          true,
          "eligible",
          `openclaw/repo#${index + 1}`,
        ),
      ),
    ],
    maxTargets: 1,
    pageSize: 20,
  });
  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  const summary = JSON.parse(scenario.first.stdout);
  assert.equal(summary.inventory_complete, false);
  assert.deepEqual(summary.skip_reasons, { inventory_incomplete: 4_999 });
  assertSkipAccountingComplete(summary);
  assert.equal(scenario.inventoryRequests, 250);
  assert.deepEqual(scenario.resolutions[0]?.ids, ["invalid"]);
  assert.equal(scenario.recoveries.length, 0);
});

test("automatic recovery defers after cleanup unparks previously hidden aliases", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [
      row(
        "primary",
        "publication:primary",
        1,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/old#9",
      ),
      row(
        "duplicate",
        "publication:duplicate",
        2,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/old#9",
      ),
    ],
    unparkAliasOnResolve: row(
      "active-alias",
      "publication:active-alias",
      3,
      "retry_exhausted",
      false,
      "fresh_review_already_active",
      "openclaw/new#9",
    ),
    nodeId: () => "ISSUE_CANONICAL_9",
  });
  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  assert.equal(scenario.resolutions.length, 1);
  assert.equal(scenario.recoveries.length, 0);
});

test("terminal cleanup stops immediately when it unparks new inventory", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [
      row(
        "closed-first",
        "publication:first",
        1,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#1",
      ),
      row(
        "closed-second",
        "publication:second",
        2,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#2",
      ),
    ],
    closedNumbers: [1, 2],
    unparkAliasOnResolve: row(
      "active-alias",
      "publication:active-alias",
      3,
      "retry_exhausted",
      false,
      "fresh_review_already_active",
      "openclaw/new#19",
    ),
  });
  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  assert.equal(scenario.resolutions.length, 1);
  assert.equal(scenario.recoveries.length, 0);
});

test("automatic recovery stops after a successful recovery unparks hidden aliases", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [
      row("first", "publication:first", 1, "retry_exhausted", true, "eligible", "openclaw/repo#1"),
      row(
        "second",
        "publication:second",
        2,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#2",
      ),
    ],
    unparkAliasOnRecovery: row(
      "active-alias",
      "publication:active-alias",
      3,
      "retry_exhausted",
      false,
      "fresh_review_already_active",
      "openclaw/new#2",
    ),
  });
  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  assert.equal(JSON.parse(scenario.first.stdout).recovered_targets, 2);
  assert.deepEqual(
    scenario.recoveries.map((recovery) => recovery.ids),
    [["first", "second"]],
  );
});

test("automatic recovery stops when a skipped recovery unparks a hidden active alias", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [
      row("first", "publication:first", 1, "retry_exhausted", true, "eligible", "openclaw/repo#1"),
      row(
        "second",
        "publication:second",
        2,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#2",
      ),
    ],
    maxRecoveries: 1,
    skippedFirstRecovery: true,
    unparkAliasOnRecovery: row(
      "active-alias",
      "publication:active-alias",
      3,
      "retry_exhausted",
      false,
      "fresh_review_already_active",
      "openclaw/new#19",
    ),
  });
  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  assert.equal(JSON.parse(scenario.first.stdout).recovered_targets, 0);
  assert.deepEqual(
    scenario.recoveries.map((recovery) => recovery.ids[0]),
    ["first"],
  );
});

test("automatic reconciliation preserves every independently active review fence", async () => {
  const scenario = await automaticReconcileScenario({
    rows: Array.from({ length: 21 }, (_, index) =>
      row(
        `active-${String(index).padStart(2, "0")}`,
        `publication:${index}`,
        index + 1,
        "retry_exhausted",
        false,
        "fresh_review_already_active",
        "openclaw/repo#8",
      ),
    ),
    repeat: true,
  });
  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  assert.equal(scenario.second?.code, 0, scenario.second?.stderr);
  assert.equal(JSON.parse(scenario.first.stdout).active_review_rows, 0);
  assert.equal(JSON.parse(scenario.second.stdout).active_review_rows, 0);
  assert.equal(scenario.recoveries.length, 0);
  assert.equal(scenario.resolutions.length, 0);
});

test("singleton active sentinels cannot starve actionable canonical targets", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [
      ...Array.from({ length: 4 }, (_, index) =>
        row(
          `active-${index}`,
          `publication:active-${index}`,
          index + 1,
          "retry_exhausted",
          false,
          "fresh_review_already_active",
          `openclaw/repo#${index + 1}`,
        ),
      ),
      row("fix", "publication:fix", 5, "retry_exhausted", true, "eligible", "openclaw/repo#5"),
    ],
    maxTargets: 1,
  });
  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  assert.equal(JSON.parse(scenario.first.stdout).inspected_targets, 1);
  assert.deepEqual(scenario.recoveries[0]?.ids, ["fix"]);
});

test("permanently ineligible targets cannot starve bounded recoveries", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [
      row(
        "disabled",
        "publication:disabled",
        1,
        "retry_exhausted",
        false,
        "target_not_enabled",
        "openclaw/clawhub#1",
      ),
      row("fix", "publication:fix", 2, "retry_exhausted", true, "eligible", "openclaw/repo#2"),
    ],
    maxTargets: 1,
  });
  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  assert.equal(JSON.parse(scenario.first.stdout).inspected_targets, 1);
  assert.deepEqual(scenario.recoveries[0]?.ids, ["fix"]);
});

test("distinct active publication and review fences survive transferred aliases", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [
      row(
        "publication-fence",
        "publication:publication-fence",
        1,
        "retry_exhausted",
        false,
        "publication_item_active",
        "openclaw/old#7",
      ),
      row(
        "review-fence",
        "publication:review-fence",
        2,
        "retry_exhausted",
        false,
        "fresh_review_already_active",
        "openclaw/new#19",
      ),
    ],
    nodeId: () => "ISSUE_CANONICAL_TRANSFERRED",
  });
  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  assert.equal(scenario.resolutions.length, 0);
  assert.equal(scenario.recoveries.length, 0);
});

test("every independently active transferred alias remains fenced", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [
      row(
        "old-fence",
        "publication:old-fence",
        1,
        "retry_exhausted",
        false,
        "publication_item_active",
        "openclaw/old#7",
      ),
      row(
        "new-fence",
        "publication:new-fence",
        2,
        "retry_exhausted",
        false,
        "publication_item_active",
        "openclaw/new#19",
      ),
    ],
    nodeId: () => "ISSUE_CANONICAL_TRANSFERRED",
  });
  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  assert.equal(scenario.resolutions.length, 0);
  assert.equal(scenario.recoveries.length, 0);
});

test("reconciliation fully inventories more than 2,000 supported dead letters", async () => {
  const scenario = await automaticReconcileScenario({
    rows: Array.from({ length: 2001 }, (_, index) =>
      row(
        `fix-${String(index).padStart(4, "0")}`,
        `publication:${index}`,
        index + 1,
        "retry_exhausted",
        true,
        "eligible",
        `openclaw/repo#${index + 1}`,
      ),
    ),
    maxTargets: 100,
    maxRecoveries: 1,
    pageSize: 20,
  });
  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  assert.equal(JSON.parse(scenario.first.stdout).inventory_complete, true);
  assert.equal(scenario.inventoryRequests, 101);
  assert.equal(scenario.recoveries[0]?.ids.length, 1);
});

test("100-target reconciliation batches canonical lookups within the GitHub token budget", async () => {
  const scenario = await automaticReconcileScenario({
    rows: Array.from({ length: 100 }, (_, index) =>
      row(
        `budget-${index}`,
        `publication:budget-${index}`,
        index + 1,
        "retry_exhausted",
        true,
        "eligible",
        `openclaw/repo#${index + 1}`,
      ),
    ),
    maxTargets: 100,
    maxRecoveries: 10,
  });
  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  assert.equal(scenario.graphqlRequests, 3);
  assert.equal(scenario.restRequests, 10);
  assert.equal(
    scenario.recoveries.reduce((count, recovery) => count + recovery.ids.length, 0),
    10,
  );
  assert.deepEqual(
    new Set(scenario.targetReadAuthorizations),
    new Set(["Bearer test-target-app-token"]),
  );
});

test("batched canonical discovery skips a throttled batch and inspects later targets", async () => {
  const scenario = await automaticReconcileScenario({
    rows: Array.from({ length: 50 }, (_, index) =>
      row(
        `batch-${index + 1}`,
        `publication:batch-${index + 1}`,
        index + 1,
        "retry_exhausted",
        true,
        "eligible",
        `openclaw/repo#${index + 1}`,
      ),
    ),
    maxTargets: 100,
    maxRecoveries: 10,
    failGraphqlRequests: 1,
    failedStatus: 403,
    throttleFailures: true,
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  const summary = JSON.parse(scenario.first.stdout);
  assert.deepEqual(summary.skip_reasons, { github_throttled: 40 });
  assert.equal(summary.skipped_targets, 40);
  assert.equal(summary.recovered_targets, 10);
  assert.equal(scenario.graphqlRequests, 2);
  assert.equal(scenario.restRequests, 10);
});

test("batched canonical discovery aborts on an authorization 403", async () => {
  const scenario = await automaticReconcileScenario({
    rows: Array.from({ length: 50 }, (_, index) =>
      row(
        `authorization-${index + 1}`,
        `publication:authorization-${index + 1}`,
        index + 1,
        "retry_exhausted",
        true,
        "eligible",
        `openclaw/repo#${index + 1}`,
      ),
    ),
    maxTargets: 100,
    maxRecoveries: 10,
    failGraphqlRequests: 1,
    failedStatus: 403,
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  const summary = JSON.parse(scenario.first.stdout);
  assert.deepEqual(summary.skip_reasons, { http_403: 40, not_inspected_abort: 10 });
  assert.equal(summary.skipped_targets, 50);
  assert.equal(summary.recovered_targets, 0);
  assert.equal(scenario.graphqlRequests, 1);
  assert.equal(scenario.restRequests, 0);
});

test("terminal target rechecks stay bounded for closed issues and pull requests", async () => {
  const targets = Array.from({ length: 100 }, (_, index) => index + 1);
  for (const kind of ["issue", "pull_request"]) {
    const scenario = await automaticReconcileScenario({
      rows: targets.map((number) =>
        row(
          `${kind}-${number}`,
          `publication:${kind}-${number}`,
          number,
          "retry_exhausted",
          true,
          "eligible",
          `openclaw/repo#${number}`,
        ),
      ),
      closedNumbers: targets,
      maxTargets: 100,
      maxRecoveries: 10,
      ...(kind === "pull_request"
        ? { pullRequestHeads: new Map(targets.map((number) => [number, "a".repeat(40)])) }
        : {}),
    });
    assert.equal(scenario.first.code, 0, scenario.first.stderr);
    assert.equal(scenario.graphqlRequests, 3);
    assert.equal(scenario.restRequests, kind === "issue" ? 10 : 20);
    assert.equal(scenario.resolutions.length, 10, `${kind}: ${scenario.first.stdout}`);
  }
});

test("mid-sized closed pull-request inventories use GraphQL identity batching", async () => {
  for (const count of [32, 40]) {
    const targets = Array.from({ length: count }, (_, index) => index + 1);
    const scenario = await automaticReconcileScenario({
      rows: targets.map((number) =>
        row(
          `mid-sized-${number}`,
          `publication:mid-sized-${number}`,
          number,
          "retry_exhausted",
          true,
          "eligible",
          `openclaw/repo#${number}`,
        ),
      ),
      closedNumbers: targets,
      pullRequestHeads: new Map(targets.map((number) => [number, "b".repeat(40)])),
      maxTargets: 100,
      maxRecoveries: 10,
    });
    assert.equal(scenario.first.code, 0, scenario.first.stderr);
    assert.equal(scenario.graphqlRequests, 1, `target count ${count}`);
    assert.equal(scenario.restRequests, 20, `target count ${count}`);
    assert.equal(scenario.resolutions.length, 10, `target count ${count}`);
  }
});

test("direct reconciliation defaults match the 100-target, ten-recovery schedule", async () => {
  const scenario = await automaticReconcileScenario({
    rows: Array.from({ length: 100 }, (_, index) =>
      row(
        `default-${index}`,
        `publication:default-${index}`,
        index + 1,
        "retry_exhausted",
        true,
        "eligible",
        `openclaw/repo#${index + 1}`,
      ),
    ),
    omitLimits: true,
  });
  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  assert.equal(scenario.graphqlRequests, 3);
  assert.equal(scenario.restRequests, 10);
  assert.equal(JSON.parse(scenario.first.stdout).recovered_targets, 10);
});

test("merged GraphQL pull requests are terminal and do not block other targets", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [
      row(
        "merged",
        "publication:merged",
        1,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#1",
      ),
      row("fix", "publication:fix", 2, "retry_exhausted", true, "eligible", "openclaw/repo#2"),
    ],
    maxTargets: 1,
    mergedNumbers: [1],
    repeat: true,
  });
  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  assert.deepEqual(scenario.resolutions[0]?.ids, ["merged"]);
  assert.equal(scenario.second?.code, 0, scenario.second?.stderr);
  assert.deepEqual(scenario.recoveries[0]?.ids, ["fix"]);
});

test("automatic recovery respects current and shrinking queue capacity", async () => {
  const rows = Array.from({ length: 3 }, (_, index) =>
    row(
      `fix-${index}`,
      `publication:${index}`,
      index + 1,
      "retry_exhausted",
      true,
      "eligible",
      `openclaw/repo#${index + 1}`,
    ),
  );
  const full = await automaticReconcileScenario({
    rows,
    pressureDetails: () => ({ active: 2, capacity: 2 }),
  });
  assert.equal(full.first.code, 0, full.first.stderr);
  assert.equal(full.recoveries.length, 0);

  const limited = await automaticReconcileScenario({
    rows,
    pressureDetails: () => ({ active: 1, capacity: 2 }),
  });
  assert.equal(limited.first.code, 0, limited.first.stderr);
  assert.equal(limited.recoveries[0]?.ids.length, 1);

  let checks = 0;
  const shrinking = await automaticReconcileScenario({
    rows,
    pressureDetails: () => ({ active: ++checks > 4 ? 2 : 0, capacity: 2 }),
  });
  assert.equal(shrinking.first.code, 0, shrinking.first.stderr);
  assert.equal(shrinking.recoveries.length, 0);
});

test("capacity-blocked open targets cannot starve later closed-target cleanup", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [
      row(
        "blocked",
        "publication:blocked",
        1,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#1",
      ),
      row(
        "closed",
        "publication:closed",
        2,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#2",
      ),
    ],
    maxTargets: 1,
    closedNumbers: [2],
    pressureDetails: () => ({ active: 1, capacity: 1 }),
  });
  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  assert.deepEqual(scenario.resolutions[0]?.ids, ["closed"]);
  assert.equal(scenario.recoveries.length, 0);
});

test("automatic recovery includes the authoritative transferred GitHub target alias", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [row("old", "publication:old", 1, "retry_exhausted", true, "eligible", "openclaw/old#7")],
    canonicalTarget: () => ({ repository: "openclaw/new", number: 19 }),
  });
  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  assert.deepEqual(scenario.recoveries[0]?.recovery_aliases, [
    { id: "old", aliases: ["openclaw/old#7", "openclaw/new#19"] },
  ]);
  assert.deepEqual(scenario.recoveries[0]?.recovery_targets, [
    { id: "old", target: "openclaw/new#19" },
  ]);
});

test("automatic recovery preserves the only duplicate matching the current pull-request head", async () => {
  const stale = row(
    "stale-primary",
    "publication:stale-primary",
    1,
    "retry_exhausted",
    true,
    "eligible",
    "openclaw/repo#7",
  );
  stale.item = {
    decision: { publication: { producerDecision: { sourceHeadSha: "a".repeat(40) } } },
  };
  const current = row(
    "current-duplicate",
    "publication:current-duplicate",
    2,
    "retry_exhausted",
    true,
    "eligible",
    "openclaw/repo#7",
  );
  current.item = {
    decision: { publication: { producerDecision: { sourceHeadSha: "b".repeat(40) } } },
  };
  const scenario = await automaticReconcileScenario({
    rows: [stale, current],
    pullRequestHeads: new Map([[7, "b".repeat(40)]]),
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  assert.deepEqual(scenario.resolutions[0]?.ids, ["stale-primary"]);
  assert.deepEqual(scenario.recoveries[0]?.ids, ["current-duplicate"]);
  assert.deepEqual(scenario.recoveries[0]?.recovery_targets, [
    { id: "current-duplicate", target: "openclaw/repo#7", source_head_sha: "b".repeat(40) },
  ]);
});

test("duplicate resolution fences every transferred canonical sibling alias", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [
      row("old", "publication:old", 1, "retry_exhausted", true, "eligible", "openclaw/old#7"),
      row(
        "intermediate",
        "publication:intermediate",
        2,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/intermediate#11",
      ),
      row(
        "sibling",
        "publication:sibling",
        3,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/sibling#12",
      ),
    ],
    nodeId: () => "ISSUE_TRANSFERRED",
    canonicalTarget: () => ({ repository: "openclaw/new", number: 19 }),
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  assert.equal(scenario.resolutions.length, 1);
  for (const guard of scenario.resolutions[0].resolution_aliases) {
    assert.deepEqual(
      new Set(guard.aliases),
      new Set([
        "openclaw/old#7",
        "openclaw/intermediate#11",
        "openclaw/sibling#12",
        "openclaw/new#19",
      ]),
    );
  }
});

test("automatic reconciliation does not resolve a target that has reopened", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [
      row(
        "reopened",
        "publication:reopened",
        1,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#1",
      ),
      row(
        "open",
        "publication:open",
        2,
        "retry_exhausted",
        false,
        "target_not_enabled",
        "openclaw/repo#2",
      ),
    ],
    maxTargets: 1,
    reopenedNumbers: [1],
  });
  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  assert.equal(scenario.resolutions.length, 0);
  assert.equal(scenario.recoveries.length, 0);
});

test("inaccessible canonical targets cannot starve independently invalid dead letters", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [
      row(
        "invalid-terminal",
        "publication:invalid-terminal",
        1,
        "tuple_protocol_invalid",
        false,
        "invalid_dead_letter_item",
        null,
      ),
      row(
        "inaccessible",
        "publication:inaccessible",
        2,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/missing#1",
      ),
    ],
    failedRepository: "missing",
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  assert.deepEqual(scenario.resolutions[0]?.ids, ["invalid-terminal"]);
  assert.equal(scenario.recoveries.length, 0);
  assert.equal(JSON.parse(scenario.first.stdout).invalid_rows, 1);
});

test("serial canonical discovery skips one throttle and recovers later targets", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [
      row("first", "publication:first", 1, "retry_exhausted", true, "eligible", "openclaw/first#1"),
      row(
        "second",
        "publication:second",
        2,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/second#2",
      ),
      row("third", "publication:third", 3, "retry_exhausted", true, "eligible", "openclaw/third#3"),
    ],
    failedRepository: "first",
    failedStatus: 403,
    throttleFailures: true,
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  const summary = JSON.parse(scenario.first.stdout);
  assert.deepEqual(summary.skip_reasons, { github_throttled: 1 });
  assert.deepEqual(summary.skip_samples, [
    {
      target: "openclaw/first#1",
      reason:
        "live target check failed for openclaw/first#1 (403): API rate limit exceeded for installation",
    },
  ]);
  assert.equal(summary.skipped_targets, 1);
  assert.equal(summary.recovered_targets, 2);
  assert.equal(scenario.restRequests, 5);
  assert.deepEqual(
    scenario.recoveries.map((recovery) => recovery.ids),
    [["second", "third"]],
  );
  assert.equal(scenario.resolutions.length, 0);
});

test("multi-owner reconciliation recovers installed targets and reports missing installations", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const scenario = await automaticReconcileScenario({
    rows: [
      row(
        "installed",
        "publication:installed",
        1,
        "retry_exhausted",
        true,
        "eligible",
        "installed-owner/repo#1",
      ),
      row(
        "missing",
        "publication:missing",
        2,
        "retry_exhausted",
        true,
        "eligible",
        "missing-owner/repo#2",
      ),
    ],
    targetInstallations: new Map([
      ["installed-owner", { id: 123, token: "installed-owner-token" }],
      ["missing-owner", null],
    ]),
    operatorEnv: {
      GH_TOKEN: "",
      EXACT_REVIEW_TARGET_TOKEN_MODE: "github-app",
      CLAWSWEEPER_APP_CLIENT_ID: "Iv23multiowner",
      CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
    },
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  const summary = JSON.parse(scenario.first.stdout);
  assert.equal(summary.recovered_targets, 1);
  assert.equal(summary.skipped_targets, 1);
  assert.deepEqual(summary.skip_reasons, { installation_missing: 1 });
  assert.deepEqual(summary.skip_samples, [
    {
      target: "missing-owner/repo#2",
      reason: "GitHub App installation is missing or revoked for missing-owner/repo",
    },
  ]);
  assert.deepEqual(
    scenario.recoveries.map((recovery) => recovery.ids),
    [["installed"]],
  );
  assert.deepEqual(scenario.installationRequests, ["installed-owner/repo", "missing-owner/repo"]);
  assert.deepEqual(scenario.tokenMintRequests, [123]);
  assert.deepEqual(
    new Set(scenario.targetReadAuthorizations),
    new Set(["Bearer installed-owner-token"]),
  );
});

test("a missing selected repository does not hide an accessible repository under the same owner", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const scenario = await automaticReconcileScenario({
    rows: [
      row(
        "missing",
        "publication:missing",
        1,
        "retry_exhausted",
        true,
        "eligible",
        "selected-owner/missing#1",
      ),
      row(
        "accessible",
        "publication:accessible",
        2,
        "retry_exhausted",
        true,
        "eligible",
        "selected-owner/accessible#2",
      ),
    ],
    targetInstallations: new Map([
      ["selected-owner/missing", null],
      ["selected-owner/accessible", { id: 124, token: "selected-owner-token" }],
    ]),
    operatorEnv: {
      GH_TOKEN: "",
      EXACT_REVIEW_TARGET_TOKEN_MODE: "github-app",
      CLAWSWEEPER_APP_CLIENT_ID: "Iv23selectedrepos",
      CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
    },
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  const summary = JSON.parse(scenario.first.stdout);
  assert.equal(summary.recovered_targets, 1);
  assert.equal(summary.skipped_targets, 1);
  assert.deepEqual(summary.skip_reasons, { installation_missing: 1 });
  assert.deepEqual(
    scenario.recoveries.map((recovery) => recovery.ids),
    [["accessible"]],
  );
  assert.deepEqual(scenario.installationRequests, [
    "selected-owner/missing",
    "selected-owner/accessible",
  ]);
  assert.deepEqual(scenario.tokenMintRequests, [124]);
  assert.deepEqual(
    new Set(scenario.targetReadAuthorizations),
    new Set(["Bearer selected-owner-token"]),
  );
});

for (const failedStatus of [429, 403]) {
  test(`throttled owner token mint ${failedStatus} skips that owner's targets and recovers another owner`, async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const scenario = await automaticReconcileScenario({
      rows: [
        row(
          "owner-a-first",
          "publication:owner-a-first",
          1,
          "retry_exhausted",
          true,
          "eligible",
          "owner-a/first#1",
        ),
        row(
          "owner-a-second",
          "publication:owner-a-second",
          2,
          "retry_exhausted",
          true,
          "eligible",
          "owner-a/second#2",
        ),
        row(
          "owner-a-third",
          "publication:owner-a-third",
          3,
          "retry_exhausted",
          true,
          "eligible",
          "owner-a/third#3",
        ),
        row(
          "owner-b",
          "publication:owner-b",
          4,
          "retry_exhausted",
          true,
          "eligible",
          "owner-b/repo#4",
        ),
      ],
      targetInstallations: new Map([
        ["owner-a", { id: 201, token: "owner-a-token" }],
        ["owner-b", { id: 202, token: "owner-b-token" }],
      ]),
      tokenMintFailures: new Map([[201, { status: failedStatus, throttle: true }]]),
      operatorEnv: {
        GH_TOKEN: "",
        EXACT_REVIEW_TARGET_TOKEN_MODE: "github-app",
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23mintthrottle",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
      },
    });

    assert.equal(scenario.first.code, 0, scenario.first.stderr);
    const summary = JSON.parse(scenario.first.stdout);
    assert.equal(summary.recovered_targets, 1);
    assert.equal(summary.skipped_targets, 3);
    assert.deepEqual(summary.skip_reasons, { github_throttled: 3 });
    assert.deepEqual(summary.skip_samples, [
      {
        target: "owner-a/first#1",
        reason: `github_throttled scope=app_setup stage=token_mint owner=owner-a status=${failedStatus}`,
      },
      {
        target: "owner-a/second#2",
        reason: `github_throttled scope=app_setup stage=token_mint owner=owner-a status=${failedStatus}`,
      },
      {
        target: "owner-a/third#3",
        reason: `github_throttled scope=app_setup stage=token_mint owner=owner-a status=${failedStatus}`,
      },
    ]);
    assert.deepEqual(
      scenario.recoveries.map((recovery) => recovery.ids),
      [["owner-b"]],
    );
    assert.deepEqual(scenario.installationRequests, ["owner-a/first", "owner-b/repo"]);
    assert.deepEqual(scenario.tokenMintRequests, [201, 202]);
    assert.deepEqual(new Set(scenario.targetReadAuthorizations), new Set(["Bearer owner-b-token"]));
  });
}

test("throttled installation lookup skips that owner's targets and recovers another owner", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const scenario = await automaticReconcileScenario({
    rows: [
      row(
        "owner-a",
        "publication:owner-a",
        1,
        "retry_exhausted",
        true,
        "eligible",
        "owner-a/repo#1",
      ),
      row(
        "owner-b",
        "publication:owner-b",
        2,
        "retry_exhausted",
        true,
        "eligible",
        "owner-b/repo#2",
      ),
    ],
    targetInstallations: new Map([
      ["owner-a", { id: 301, token: "owner-a-token" }],
      ["owner-b", { id: 302, token: "owner-b-token" }],
    ]),
    installationFailures: new Map([["owner-a", { status: 403, throttle: true }]]),
    operatorEnv: {
      GH_TOKEN: "",
      EXACT_REVIEW_TARGET_TOKEN_MODE: "github-app",
      CLAWSWEEPER_APP_CLIENT_ID: "Iv23lookupthrottle",
      CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
    },
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  const summary = JSON.parse(scenario.first.stdout);
  assert.equal(summary.recovered_targets, 1);
  assert.equal(summary.skipped_targets, 1);
  assert.deepEqual(summary.skip_reasons, { github_throttled: 1 });
  assert.deepEqual(summary.skip_samples, [
    {
      target: "owner-a/repo#1",
      reason: "github_throttled scope=app_setup stage=installation_lookup owner=owner-a status=403",
    },
  ]);
  assert.deepEqual(scenario.installationRequests, ["owner-a/repo", "owner-b/repo"]);
  assert.deepEqual(scenario.tokenMintRequests, [302]);
  assert.deepEqual(
    scenario.recoveries.map((recovery) => recovery.ids),
    [["owner-b"]],
  );
});

test("an installation removed before token mint remains a bounded missing-installation skip", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const scenario = await automaticReconcileScenario({
    rows: [
      row(
        "owner-a",
        "publication:owner-a",
        1,
        "retry_exhausted",
        true,
        "eligible",
        "owner-a/repo#1",
      ),
      row(
        "owner-b",
        "publication:owner-b",
        2,
        "retry_exhausted",
        true,
        "eligible",
        "owner-b/repo#2",
      ),
    ],
    targetInstallations: new Map([
      ["owner-a", { id: 351, token: "owner-a-token" }],
      ["owner-b", { id: 352, token: "owner-b-token" }],
    ]),
    tokenMintFailures: new Map([[351, { status: 404, throttle: false }]]),
    operatorEnv: {
      GH_TOKEN: "",
      EXACT_REVIEW_TARGET_TOKEN_MODE: "github-app",
      CLAWSWEEPER_APP_CLIENT_ID: "Iv23mintmissing",
      CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
    },
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  const summary = JSON.parse(scenario.first.stdout);
  assert.equal(summary.recovered_targets, 1);
  assert.equal(summary.skipped_targets, 1);
  assert.deepEqual(summary.skip_reasons, { installation_missing: 1 });
  assert.deepEqual(scenario.installationRequests, ["owner-a/repo", "owner-b/repo"]);
  assert.deepEqual(scenario.tokenMintRequests, [351, 352]);
  assert.deepEqual(
    scenario.recoveries.map((recovery) => recovery.ids),
    [["owner-b"]],
  );
});

test("batched discovery skips a throttled owner setup and continues with another owner", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const scenario = await automaticReconcileScenario({
    rows: [
      row(
        "owner-a",
        "publication:owner-a",
        1,
        "retry_exhausted",
        true,
        "eligible",
        "owner-a/repo#1",
      ),
      ...Array.from({ length: 10 }, (_, index) =>
        row(
          `owner-b-${index + 1}`,
          `publication:owner-b-${index + 1}`,
          index + 2,
          "retry_exhausted",
          true,
          "eligible",
          `owner-b/repo-${index + 1}#${index + 2}`,
        ),
      ),
    ],
    maxTargets: 100,
    maxRecoveries: 10,
    targetInstallations: new Map([
      ["owner-a", { id: 601, token: "owner-a-token" }],
      ["owner-b", { id: 602, token: "owner-b-token" }],
    ]),
    tokenMintFailures: new Map([[601, { status: 403, throttle: true }]]),
    operatorEnv: {
      GH_TOKEN: "",
      EXACT_REVIEW_TARGET_TOKEN_MODE: "github-app",
      CLAWSWEEPER_APP_CLIENT_ID: "Iv23batchsetupthrottle",
      CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
    },
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  const summary = JSON.parse(scenario.first.stdout);
  assert.equal(summary.recovered_targets, 10);
  assert.equal(summary.skipped_targets, 1);
  assert.deepEqual(summary.skip_reasons, { github_throttled: 1 });
  assert.deepEqual(scenario.installationRequests, ["owner-a/repo", "owner-b/repo-1"]);
  assert.deepEqual(scenario.tokenMintRequests, [601, 602]);
  assert.equal(scenario.graphqlRequests, 1);
  assert.deepEqual(new Set(scenario.targetReadAuthorizations), new Set(["Bearer owner-b-token"]));
});

test("a cached setup throttle spanning three batches counts once and later owners continue", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const scenario = await automaticReconcileScenario({
    rows: [
      ...Array.from({ length: 81 }, (_, index) =>
        row(
          `owner-a-${index + 1}`,
          `publication:owner-a-${index + 1}`,
          index + 1,
          "retry_exhausted",
          true,
          "eligible",
          `owner-a/repo-${index + 1}#${index + 1}`,
        ),
      ),
      row(
        "owner-b",
        "publication:owner-b",
        82,
        "retry_exhausted",
        true,
        "eligible",
        "owner-b/repo#82",
      ),
    ],
    maxTargets: 100,
    maxRecoveries: 10,
    targetInstallations: new Map([
      ["owner-a", { id: 701, token: "owner-a-token" }],
      ["owner-b", { id: 702, token: "owner-b-token" }],
    ]),
    tokenMintFailures: new Map([[701, { status: 429, throttle: true }]]),
    operatorEnv: {
      GH_TOKEN: "",
      EXACT_REVIEW_TARGET_TOKEN_MODE: "github-app",
      CLAWSWEEPER_APP_CLIENT_ID: "Iv23cachedsetupthrottle",
      CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
    },
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  const summary = JSON.parse(scenario.first.stdout);
  assert.equal(summary.recovered_targets, 1);
  assert.equal(summary.skipped_targets, 81);
  assert.deepEqual(summary.skip_reasons, { github_throttled: 81 });
  assert.deepEqual(scenario.installationRequests, ["owner-a/repo-1", "owner-b/repo"]);
  assert.deepEqual(scenario.tokenMintRequests, [701, 702]);
  assert.equal(scenario.graphqlRequests, 1);
  assert.deepEqual(
    scenario.recoveries.map((recovery) => recovery.ids),
    [["owner-b"]],
  );
});

for (const stage of ["installation_lookup", "token_mint"]) {
  for (const failedStatus of [401, 403]) {
    test(`ordinary ${stage} ${failedStatus} remains fail-closed`, async () => {
      const { privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      const scenario = await automaticReconcileScenario({
        rows: [
          row(
            "owner-a",
            "publication:owner-a",
            1,
            "retry_exhausted",
            true,
            "eligible",
            "owner-a/repo#1",
          ),
          row(
            "owner-b",
            "publication:owner-b",
            2,
            "retry_exhausted",
            true,
            "eligible",
            "owner-b/repo#2",
          ),
        ],
        targetInstallations: new Map([
          ["owner-a", { id: 401, token: "owner-a-token" }],
          ["owner-b", { id: 402, token: "owner-b-token" }],
        ]),
        ...(stage === "installation_lookup"
          ? {
              installationFailures: new Map([
                ["owner-a", { status: failedStatus, throttle: false }],
              ]),
            }
          : {
              tokenMintFailures: new Map([[401, { status: failedStatus, throttle: false }]]),
            }),
        operatorEnv: {
          GH_TOKEN: "",
          EXACT_REVIEW_TARGET_TOKEN_MODE: "github-app",
          CLAWSWEEPER_APP_CLIENT_ID: "Iv23setupauth",
          CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        },
      });

      assert.equal(scenario.first.code, 0, scenario.first.stderr);
      const summary = JSON.parse(scenario.first.stdout);
      assert.equal(summary.recovered_targets, 0);
      assert.deepEqual(summary.skip_reasons, {
        [failedStatus === 403 ? "http_403" : "http_4xx"]: 1,
        not_inspected_abort: 1,
      });
      assert.deepEqual(scenario.installationRequests, ["owner-a/repo"]);
      assert.deepEqual(scenario.tokenMintRequests, stage === "token_mint" ? [401] : []);
    });
  }
}

test("persistent setup throttling trips the shared fuse before another owner is attempted", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const installations = new Map(
    ["owner-a", "owner-b", "owner-c", "owner-d"].map((owner, index) => [
      owner,
      { id: 501 + index, token: `${owner}-token` },
    ]),
  );
  const scenario = await automaticReconcileScenario({
    rows: [...installations.keys()].map((owner, index) =>
      row(
        owner,
        `publication:${owner}`,
        index + 1,
        "retry_exhausted",
        true,
        "eligible",
        `${owner}/repo#${index + 1}`,
      ),
    ),
    targetInstallations: installations,
    tokenMintFailures: new Map(
      [...installations.values()].map(({ id }) => [id, { status: 429, throttle: true }]),
    ),
    operatorEnv: {
      GH_TOKEN: "",
      EXACT_REVIEW_TARGET_TOKEN_MODE: "github-app",
      CLAWSWEEPER_APP_CLIENT_ID: "Iv23setupfuse",
      CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
    },
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  const summary = JSON.parse(scenario.first.stdout);
  assert.equal(summary.recovered_targets, 0);
  assert.deepEqual(summary.skip_reasons, { github_throttled: 3, not_inspected_abort: 1 });
  assert.deepEqual(scenario.installationRequests, ["owner-a/repo", "owner-b/repo", "owner-c/repo"]);
  assert.deepEqual(scenario.tokenMintRequests, [501, 502, 503]);
  assert.equal(scenario.restRequests, 0);
});

test("authorization 403 with a valid owner installation remains fail-closed", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const scenario = await automaticReconcileScenario({
    rows: [
      row("first", "publication:first", 1, "retry_exhausted", true, "eligible", "owner/first#1"),
      row("second", "publication:second", 2, "retry_exhausted", true, "eligible", "owner/second#2"),
      row("third", "publication:third", 3, "retry_exhausted", true, "eligible", "owner/third#3"),
    ],
    targetInstallations: new Map([["owner", { id: 456, token: "owner-token" }]]),
    operatorEnv: {
      GH_TOKEN: "",
      EXACT_REVIEW_TARGET_TOKEN_MODE: "github-app",
      CLAWSWEEPER_APP_CLIENT_ID: "Iv23authorization",
      CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
    },
    failedRepository: "first",
    failedStatus: 403,
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  const summary = JSON.parse(scenario.first.stdout);
  assert.deepEqual(summary.skip_reasons, { http_403: 1, not_inspected_abort: 2 });
  assert.equal(summary.recovered_targets, 0);
  assert.deepEqual(scenario.installationRequests, ["owner/first"]);
  assert.deepEqual(scenario.tokenMintRequests, [456]);
  assert.deepEqual(new Set(scenario.targetReadAuthorizations), new Set(["Bearer owner-token"]));
});

test("serial canonical discovery aborts on an authorization 403", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [
      row("first", "publication:first", 1, "retry_exhausted", true, "eligible", "openclaw/first#1"),
      row(
        "second",
        "publication:second",
        2,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/second#2",
      ),
      row("third", "publication:third", 3, "retry_exhausted", true, "eligible", "openclaw/third#3"),
    ],
    failedRepository: "first",
    failedStatus: 403,
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  const summary = JSON.parse(scenario.first.stdout);
  assert.deepEqual(summary.skip_reasons, { http_403: 1, not_inspected_abort: 2 });
  assert.equal(summary.skipped_targets, 3);
  assert.equal(summary.recovered_targets, 0);
  assert.equal(scenario.restRequests, 1);
  assert.equal(scenario.recoveries.length, 0);
});

test("serial canonical discovery aborts after three consecutive throttles", async () => {
  const scenario = await automaticReconcileScenario({
    rows: Array.from({ length: 5 }, (_, index) =>
      row(
        `target-${index + 1}`,
        `publication:target-${index + 1}`,
        index + 1,
        "retry_exhausted",
        true,
        "eligible",
        `openclaw/repo-${index + 1}#${index + 1}`,
      ),
    ),
    failedRepositories: ["repo-1", "repo-2", "repo-3"],
    failedStatus: 403,
    throttleFailures: true,
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  const summary = JSON.parse(scenario.first.stdout);
  assert.deepEqual(summary.skip_reasons, { github_throttled: 3, not_inspected_abort: 2 });
  assert.equal(summary.skipped_targets, 5);
  assert.equal(scenario.restRequests, 3);
  assert.equal(scenario.recoveries.length, 0);
});

test("serial recovery revalidation skips one throttle and recovers later targets", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [
      row("first", "publication:first", 1, "retry_exhausted", true, "eligible", "openclaw/repo#1"),
      row(
        "second",
        "publication:second",
        2,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#2",
      ),
      row("third", "publication:third", 3, "retry_exhausted", true, "eligible", "openclaw/repo#3"),
    ],
    failTargetOnInspection: 1,
    failedStatus: 403,
    throttleFailures: true,
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  const summary = JSON.parse(scenario.first.stdout);
  assert.deepEqual(summary.skip_reasons, { github_throttled: 1 });
  assert.deepEqual(summary.skip_samples, [
    {
      target: "openclaw/repo#1",
      reason:
        "live target check failed for openclaw/repo#1 (403): API rate limit exceeded for installation",
    },
  ]);
  assert.equal(summary.skipped_targets, 1);
  assert.equal(summary.recovered_targets, 2);
  assert.equal(scenario.restRequests, 6);
  assert.deepEqual(
    scenario.recoveries.map((recovery) => recovery.ids),
    [["second", "third"]],
  );
  assert.equal(scenario.resolutions.length, 0);
});

test("serial recovery revalidation aborts on an authorization 403", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [
      row("first", "publication:first", 1, "retry_exhausted", true, "eligible", "openclaw/repo#1"),
      row(
        "second",
        "publication:second",
        2,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#2",
      ),
      row("third", "publication:third", 3, "retry_exhausted", true, "eligible", "openclaw/repo#3"),
    ],
    failTargetOnInspection: 1,
    failedStatus: 403,
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  const summary = JSON.parse(scenario.first.stdout);
  assert.deepEqual(summary.skip_reasons, { http_403: 1, not_inspected_abort: 2 });
  assert.equal(summary.skipped_targets, 3);
  assert.equal(summary.recovered_targets, 0);
  assert.equal(scenario.restRequests, 4);
  assert.equal(scenario.recoveries.length, 0);
});

test("serial recovery revalidation aborts after three consecutive throttles", async () => {
  const scenario = await automaticReconcileScenario({
    rows: Array.from({ length: 5 }, (_, index) =>
      row(
        `target-${index + 1}`,
        `publication:target-${index + 1}`,
        index + 1,
        "retry_exhausted",
        true,
        "eligible",
        `openclaw/repo#${index + 1}`,
      ),
    ),
    failTargetsOnInspection: [1, 2, 3],
    failedStatus: 403,
    throttleFailures: true,
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  const summary = JSON.parse(scenario.first.stdout);
  assert.deepEqual(summary.skip_reasons, { github_throttled: 3, not_inspected_abort: 2 });
  assert.equal(summary.skipped_targets, 5);
  assert.equal(scenario.restRequests, 8);
  assert.equal(scenario.recoveries.length, 0);
});

test("automatic reconciliation leaves an advanced pull-request head open without canonical proof", async () => {
  const item = row(
    "stale",
    "publication:stale",
    1,
    "retry_exhausted",
    true,
    "eligible",
    "openclaw/repo#7",
  );
  item.item = {
    decision: { publication: { producerDecision: { sourceHeadSha: "a".repeat(40) } } },
  };
  const scenario = await automaticReconcileScenario({
    rows: [item],
    pullRequestHeads: new Map([[7, "b".repeat(40)]]),
  });
  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  assert.equal(scenario.recoveries.length, 0);
  assert.equal(scenario.resolutions.length, 0);
  const summary = JSON.parse(scenario.first.stdout);
  assert.deepEqual(summary.skip_reasons, { head_mismatch_unproven: 1 });
  assert.deepEqual(summary.skip_samples, [
    {
      target: "openclaw/repo#7",
      reason: "canonical completed review record was not found for the live pull-request head",
    },
  ]);

  const staleCanonical = await automaticReconcileScenario({
    rows: [item],
    pullRequestHeads: new Map([[7, "b".repeat(40)]]),
    canonicalRecords: new Map([[7, canonicalRecordEnvelope("openclaw/repo", 7, "c".repeat(40))]]),
  });
  assert.equal(staleCanonical.first.code, 0, staleCanonical.first.stderr);
  assert.equal(staleCanonical.resolutions.length, 0);
  assert.deepEqual(JSON.parse(staleCanonical.first.stdout).skip_reasons, {
    head_mismatch_unproven: 1,
  });
  assert.equal(
    JSON.parse(staleCanonical.first.stdout).skip_samples[0].reason,
    "canonical completed review record does not prove the live pull-request head",
  );
});

test("automatic reconciliation resolves a stale publication only with canonical newer-head proof", async () => {
  const staleHead = "a".repeat(40);
  const liveHead = "b".repeat(40);
  const item = row(
    "stale",
    "publication:stale",
    1,
    "retry_exhausted",
    true,
    "eligible",
    "openclaw/repo#7",
  );
  item.item = {
    decision: { publication: { producerDecision: { sourceHeadSha: staleHead } } },
  };
  const scenario = await automaticReconcileScenario({
    rows: [item],
    pullRequestHeads: new Map([[7, liveHead]]),
    canonicalRecords: new Map([[7, canonicalRecordEnvelope("openclaw/repo", 7, liveHead)]]),
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  assert.equal(scenario.recoveries.length, 0);
  assert.equal(scenario.resolutions.length, 1);
  assert.deepEqual(scenario.resolutions[0].ids, ["stale"]);
  assert.equal(scenario.resolutions[0].resolution_outcome, "superseded");
  assert.equal(
    scenario.resolutions[0].note,
    `automatic reconciliation: stale publication superseded by completed canonical record at newer head ${liveHead}; evidence=/internal/state/records/openclaw-repo/items/7`,
  );
  assert.deepEqual(scenario.canonicalRecordRequests, [
    "/internal/state/records/openclaw-repo/items/7",
  ]);
  const summary = JSON.parse(scenario.first.stdout);
  assert.equal(summary.superseded_targets, 1);
  assert.equal(summary.superseded_rows, 1);
  assert.equal(summary.skipped_targets, 0);
  assert.deepEqual(summary.skip_reasons, {});
});

test("head-mismatch supersession revalidates the live head immediately before resolution", async () => {
  const staleHead = "a".repeat(40);
  const provenHead = "b".repeat(40);
  const advancedHead = "c".repeat(40);
  const item = row(
    "stale-race",
    "publication:stale-race",
    1,
    "retry_exhausted",
    true,
    "eligible",
    "openclaw/repo#8",
  );
  item.item = {
    decision: { publication: { producerDecision: { sourceHeadSha: staleHead } } },
  };
  const scenario = await automaticReconcileScenario({
    rows: [item],
    pullRequestHeads: new Map([[8, provenHead]]),
    pullRequestHeadsAfterEvidence: new Map([[8, advancedHead]]),
    canonicalRecords: new Map([[8, canonicalRecordEnvelope("openclaw/repo", 8, provenHead)]]),
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  assert.equal(scenario.resolutions.length, 0);
  assert.equal(scenario.recoveries.length, 0);
  assert.equal(scenario.restRequests, 4);
  const summary = JSON.parse(scenario.first.stdout);
  assert.deepEqual(summary.skip_reasons, { head_mismatch_revalidation_changed: 1 });
  assert.deepEqual(summary.skip_samples, [
    {
      target: "openclaw/repo#8",
      reason: "live pull-request identity or head changed after canonical supersession evidence",
    },
  ]);
});

test("head-mismatch supersession enforces target and row caps", async () => {
  const staleHead = "a".repeat(40);
  const liveHead = "b".repeat(40);
  const targetRows = Array.from({ length: 11 }, (_, index) => {
    const number = index + 1;
    const item = row(
      `stale-${number}`,
      `publication:stale-${number}`,
      number,
      "retry_exhausted",
      true,
      "eligible",
      `openclaw/repo#${number}`,
    );
    item.item = {
      decision: { publication: { producerDecision: { sourceHeadSha: staleHead } } },
    };
    return item;
  });
  const targetCap = await automaticReconcileScenario({
    rows: targetRows,
    maxTargets: 20,
    pullRequestHeads: new Map(targetRows.map((_, index) => [index + 1, liveHead])),
    canonicalRecords: new Map(
      targetRows.map((_, index) => [
        index + 1,
        canonicalRecordEnvelope("openclaw/repo", index + 1, liveHead),
      ]),
    ),
  });
  assert.equal(targetCap.first.code, 0, targetCap.first.stderr);
  const targetSummary = JSON.parse(targetCap.first.stdout);
  assert.equal(targetSummary.superseded_targets, 10);
  assert.equal(targetSummary.superseded_rows, 10);
  assert.equal(targetCap.resolutions.length, 10);
  assert.equal(targetCap.canonicalRecordRequests.length, 10);
  assert.deepEqual(targetSummary.skip_reasons, { head_mismatch_resolution_cap: 1 });

  const rowCapRows = Array.from({ length: 21 }, (_, index) => {
    const item = row(
      `duplicate-${index + 1}`,
      `publication:duplicate-${index + 1}`,
      index + 1,
      "retry_exhausted",
      true,
      "eligible",
      "openclaw/repo#77",
    );
    item.item = {
      decision: { publication: { producerDecision: { sourceHeadSha: staleHead } } },
    };
    return item;
  });
  const rowCap = await automaticReconcileScenario({
    rows: rowCapRows,
    pullRequestHeads: new Map([[77, liveHead]]),
    canonicalRecords: new Map([[77, canonicalRecordEnvelope("openclaw/repo", 77, liveHead)]]),
  });
  assert.equal(rowCap.first.code, 0, rowCap.first.stderr);
  const rowSummary = JSON.parse(rowCap.first.stdout);
  assert.equal(rowSummary.superseded_targets, 1);
  assert.equal(rowSummary.superseded_rows, 20);
  assert.deepEqual(
    rowCap.resolutions.map((resolution) => resolution.ids.length),
    [20],
  );
  assert.deepEqual(rowSummary.skip_reasons, { head_mismatch_resolution_partial: 1 });
});

test("head-mismatch supersession includes proven tuple failures but excludes workflow cancellation", async () => {
  const staleHead = "a".repeat(40);
  const liveHead = "b".repeat(40);
  const stale = (id, reason) => {
    const item = row(id, `publication:${id}`, 1, reason, true, "eligible", "openclaw/repo#7");
    item.item = {
      decision: { publication: { producerDecision: { sourceHeadSha: staleHead } } },
    };
    return item;
  };
  const planned = await automaticReconcileScenario({
    rows: [stale("retry", "retry_exhausted")],
    execute: false,
    pullRequestHeads: new Map([[7, liveHead]]),
    canonicalRecords: new Map([[7, canonicalRecordEnvelope("openclaw/repo", 7, liveHead)]]),
  });
  assert.equal(planned.first.code, 0, planned.first.stderr);
  assert.equal(planned.resolutions.length, 0);
  assert.equal(JSON.parse(planned.first.stdout).dry_run, true);
  assert.equal(JSON.parse(planned.first.stdout).superseded_rows, 1);

  const excluded = await automaticReconcileScenario({
    rows: [stale("cancelled", "workflow_cancelled"), stale("tuple", "tuple_protocol_invalid")],
    pullRequestHeads: new Map([[7, liveHead]]),
    canonicalRecords: new Map([[7, canonicalRecordEnvelope("openclaw/repo", 7, liveHead)]]),
  });
  assert.equal(excluded.first.code, 0, excluded.first.stderr);
  assert.equal(excluded.resolutions.length, 1);
  assert.deepEqual(excluded.resolutions[0].ids, ["tuple"]);
  assert.equal(excluded.resolutions[0].resolution_outcome, "superseded");
  assert.equal(excluded.canonicalRecordRequests.length, 1);
  assert.deepEqual(JSON.parse(excluded.first.stdout).skip_reasons, {
    head_mismatch_out_of_scope: 1,
  });
});

test("automatic reconciliation recovers a current-head tuple failure instead of superseding it", async () => {
  const liveHead = "b".repeat(40);
  const item = row(
    "tuple-current",
    "publication:tuple-current",
    1,
    "tuple_protocol_invalid",
    true,
    "eligible",
    "openclaw/repo#7",
  );
  item.item = {
    decision: { publication: { producerDecision: { sourceHeadSha: liveHead } } },
  };
  const scenario = await automaticReconcileScenario({
    rows: [item],
    pullRequestHeads: new Map([[7, liveHead]]),
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  assert.equal(scenario.resolutions.length, 0);
  assert.equal(scenario.canonicalRecordRequests.length, 0);
  assert.deepEqual(
    scenario.recoveries.map((recovery) => recovery.ids),
    [["tuple-current"]],
  );
  const summary = JSON.parse(scenario.first.stdout);
  assert.equal(summary.recovered_targets, 1);
  assert.equal(summary.superseded_targets, 0);
  assert.deepEqual(summary.skip_reasons, {});
});

test("automatic recovery revalidates the live GitHub target after cleanup", async () => {
  const scenario = await automaticReconcileScenario({
    rows: [
      row(
        "primary",
        "publication:primary",
        1,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#3",
      ),
      row(
        "duplicate",
        "publication:duplicate",
        2,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#3",
      ),
    ],
    closeAfterCleanup: true,
  });
  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  assert.equal(scenario.resolutions.length, 1);
  assert.equal(scenario.recoveries.length, 0);
  assert.deepEqual(JSON.parse(scenario.first.stdout).skip_reasons, {
    closed_state_changed: 1,
  });
});

test("automatic reconciliation classifies every deterministic skip path", async () => {
  const blockedAlias = await automaticReconcileScenario({
    rows: [
      row(
        "blocked",
        "publication:blocked",
        1,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#1",
      ),
    ],
    closedNumbers: [1],
    blockedCleanupIds: ["blocked"],
  });
  assert.equal(blockedAlias.first.code, 0, blockedAlias.first.stderr);
  assert.deepEqual(JSON.parse(blockedAlias.first.stdout).skip_reasons, { blocked_alias: 1 });

  const terminalCap = await automaticReconcileScenario({
    rows: Array.from({ length: 11 }, (_, index) =>
      row(
        `closed-${index + 1}`,
        `publication:closed-${index + 1}`,
        index + 1,
        "retry_exhausted",
        true,
        "eligible",
        `openclaw/repo#${index + 1}`,
      ),
    ),
    closedNumbers: Array.from({ length: 11 }, (_, index) => index + 1),
    maxTargets: 20,
  });
  assert.equal(terminalCap.first.code, 0, terminalCap.first.stderr);
  assert.deepEqual(JSON.parse(terminalCap.first.stdout).skip_reasons, {
    terminal_recheck_cap: 1,
  });

  const inspectionCap = await automaticReconcileScenario({
    rows: [
      row("first", "publication:first", 1, "retry_exhausted", true, "eligible", "openclaw/repo#1"),
      row(
        "second",
        "publication:second",
        2,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#2",
      ),
    ],
    closedNumbers: [1, 2],
    maxTargets: 1,
  });
  assert.equal(inspectionCap.first.code, 0, inspectionCap.first.stderr);
  assert.deepEqual(JSON.parse(inspectionCap.first.stdout).skip_reasons, { inspection_cap: 1 });

  const duplicatePartial = await automaticReconcileScenario({
    rows: Array.from({ length: 22 }, (_, index) =>
      row(
        `duplicate-${index + 1}`,
        `publication:duplicate-${index + 1}`,
        index + 1,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#7",
      ),
    ),
  });
  assert.equal(duplicatePartial.first.code, 0, duplicatePartial.first.stderr);
  assert.deepEqual(JSON.parse(duplicatePartial.first.stdout).skip_reasons, {
    duplicate_resolution_partial: 1,
  });

  const identityNotActionable = await automaticReconcileScenario({
    rows: [
      row(
        "identity",
        "publication:identity",
        1,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#1",
      ),
    ],
    identityState: () => "unknown",
  });
  assert.equal(identityNotActionable.first.code, 0, identityNotActionable.first.stderr);
  assert.deepEqual(JSON.parse(identityNotActionable.first.stdout).skip_reasons, {
    identity_not_actionable: 1,
  });

  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const mixedIdentityFailure = await automaticReconcileScenario({
    rows: [
      row(
        "missing-installation",
        "publication:missing-installation",
        1,
        "retry_exhausted",
        true,
        "eligible",
        "owner-a/repo#1",
      ),
      row(
        "identity",
        "publication:identity",
        2,
        "retry_exhausted",
        true,
        "eligible",
        "owner-b/repo#2",
      ),
    ],
    targetInstallations: new Map([["owner-b", { id: 8147, token: "owner-b-token" }]]),
    identityState: (number) => (number === 2 ? "unknown" : "open"),
    operatorEnv: {
      GH_TOKEN: "",
      EXACT_REVIEW_TARGET_TOKEN_MODE: "github-app",
      CLAWSWEEPER_APP_CLIENT_ID: "Iv23mixedidentity",
      CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
    },
  });
  assert.equal(mixedIdentityFailure.first.code, 0, mixedIdentityFailure.first.stderr);
  const mixedIdentitySummary = JSON.parse(mixedIdentityFailure.first.stdout);
  assert.equal(mixedIdentitySummary.skipped_targets, 2);
  assert.deepEqual(mixedIdentitySummary.skip_reasons, {
    installation_missing: 1,
    identity_not_actionable: 1,
  });
  assertSkipAccountingComplete(mixedIdentitySummary);

  const discoveryFailed = await automaticReconcileScenario({
    rows: Array.from({ length: 11 }, (_, index) =>
      row(
        `discovery-${index + 1}`,
        `publication:discovery-${index + 1}`,
        index + 1,
        "retry_exhausted",
        true,
        "eligible",
        `openclaw/repo#${index + 1}`,
      ),
    ),
    invalidGraphqlIdentity: 1,
    maxTargets: 20,
  });
  assert.equal(discoveryFailed.first.code, 0, discoveryFailed.first.stderr);
  assert.deepEqual(JSON.parse(discoveryFailed.first.stdout).skip_reasons, {
    discovery_failed: 11,
  });

  const mutationSkipped = await automaticReconcileScenario({
    rows: [
      row(
        "mutation",
        "publication:mutation",
        1,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#1",
      ),
    ],
    skippedFirstRecovery: true,
  });
  assert.equal(mutationSkipped.first.code, 0, mutationSkipped.first.stderr);
  assert.deepEqual(JSON.parse(mutationSkipped.first.stdout).skip_reasons, {
    recovery_mutation_skipped: 1,
  });
});

test("automatic reconciliation explains every skipped target in a mixed scenario", async () => {
  const stale = row(
    "stale",
    "publication:stale",
    3,
    "retry_exhausted",
    true,
    "eligible",
    "openclaw/repo#3",
  );
  stale.item = {
    decision: { publication: { producerDecision: { sourceHeadSha: "a".repeat(40) } } },
  };
  const scenario = await automaticReconcileScenario({
    rows: [
      row(
        "active",
        "publication:active",
        1,
        "retry_exhausted",
        false,
        "fresh_review_already_active",
        "openclaw/repo#1",
      ),
      row(
        "ineligible",
        "publication:ineligible",
        2,
        "retry_exhausted",
        false,
        "target_not_enabled",
        "openclaw/repo#2",
      ),
      stale,
      row(
        "recover",
        "publication:recover",
        4,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#4",
      ),
      row(
        "capacity",
        "publication:capacity",
        5,
        "retry_exhausted",
        true,
        "eligible",
        "openclaw/repo#5",
      ),
    ],
    pullRequestHeads: new Map([[3, "b".repeat(40)]]),
    pressureDetails: () => ({ active: 127, capacity: 128 }),
  });

  assert.equal(scenario.first.code, 0, scenario.first.stderr);
  const summary = JSON.parse(scenario.first.stdout);
  assert.deepEqual(summary.skip_reasons, {
    active_work: 1,
    no_eligible_rows: 1,
    head_mismatch_unproven: 1,
    recovery_capacity: 1,
  });
  assert.equal(summary.skipped_targets, 4);
  assertSkipAccountingComplete(summary);
  assert.ok(
    summary.skip_samples.some(
      (sample) =>
        sample.target === "openclaw/repo#2" &&
        sample.reason === "canonical target has no eligible dead-letter rows",
    ),
  );
  assert.ok(
    summary.skip_samples.some(
      (sample) =>
        sample.target === "openclaw/repo#3" &&
        sample.reason ===
          "canonical completed review record was not found for the live pull-request head",
    ),
  );
});

async function automaticReconcileScenario(options) {
  const secret = "automatic-reconcile-scenario-secret";
  const rows = options.rows.map((entry) => ({ ...entry }));
  const recoveries = [];
  const resolutions = [];
  let inventoryRequests = 0;
  let graphqlRequests = 0;
  let restRequests = 0;
  const canonicalRecordRequests = [];
  const targetReadAuthorizations = [];
  const installationRequests = [];
  const tokenMintRequests = [];
  const restRequestsByNumber = new Map();
  let duplicateFailurePending = options.failFirstDuplicateCleanup === true;
  let duplicateSkipsRemaining =
    options.skipDuplicateCleanupCount ?? Number(options.skipFirstDuplicateCleanup === true);
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.url === "/api/exact-review-queue") {
      response.writeHead(200, {
        "content-type": "application/json",
        ...(options.stalePressure ? { "x-clawsweeper-cache": "stale" } : {}),
      });
      response.end(
        JSON.stringify({
          pressure: {
            status: options.pressure?.(recoveries.length, resolutions.length) ?? "idle",
            active: 0,
            capacity: 128,
            ...options.pressureDetails?.(recoveries.length, resolutions.length),
          },
        }),
      );
      return;
    }
    const canonicalRecordMatch =
      /^\/internal\/state\/records\/openclaw-repo\/items\/([1-9]\d*)$/.exec(request.url ?? "");
    if (canonicalRecordMatch) {
      const expected = `sha256=${createHmac("sha256", secret).update("").digest("hex")}`;
      assert.equal(request.method, "GET");
      assert.equal(request.headers["x-clawsweeper-exact-review-signature"], expected);
      canonicalRecordRequests.push(request.url);
      const record = options.canonicalRecords?.get(Number(canonicalRecordMatch[1]));
      response.writeHead(record ? 200 : 404, { "content-type": "application/json" });
      response.end(JSON.stringify(record ?? { error: "record_not_found" }));
      return;
    }
    const installationMatch = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(request.url ?? "");
    if (installationMatch && options.targetInstallations) {
      const [, owner, repo] = installationMatch;
      installationRequests.push(`${owner}/${repo}`);
      const failure = options.installationFailures?.get(owner.toLowerCase());
      if (failure) {
        response.writeHead(failure.status, {
          "content-type": "application/json",
          ...(failure.throttle ? { "x-ratelimit-remaining": "0" } : {}),
        });
        response.end(
          JSON.stringify({
            message: failure.throttle
              ? "API rate limit exceeded for installation"
              : "Resource not accessible by integration",
          }),
        );
        return;
      }
      const repositoryKey = `${owner}/${repo}`.toLowerCase();
      const installationKey = options.targetInstallations.has(repositoryKey)
        ? repositoryKey
        : owner.toLowerCase();
      const installation = options.targetInstallations.get(installationKey);
      if (!installation) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: "Not Found" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: installation.id }));
      return;
    }
    const tokenMatch = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(request.url ?? "");
    if (tokenMatch && options.targetInstallations) {
      const installationId = Number(tokenMatch[1]);
      tokenMintRequests.push(installationId);
      const failure = options.tokenMintFailures?.get(installationId);
      if (failure) {
        response.writeHead(failure.status, {
          "content-type": "application/json",
          ...(failure.throttle ? { "x-ratelimit-remaining": "0" } : {}),
        });
        response.end(
          JSON.stringify({
            message: failure.throttle
              ? "API rate limit exceeded for installation"
              : "Resource not accessible by integration",
          }),
        );
        return;
      }
      const installation = [...options.targetInstallations.values()].find(
        (candidate) => candidate?.id === installationId,
      );
      assert.ok(installation);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ token: installation.token }));
      return;
    }
    if (request.url === "/graphql") {
      graphqlRequests += 1;
      targetReadAuthorizations.push(request.headers.authorization);
      if (graphqlRequests <= (options.failGraphqlRequests ?? 0)) {
        response.writeHead(options.failedStatus ?? 403, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            message: options.throttleFailures
              ? "API rate limit exceeded for installation"
              : "Resource not accessible by integration",
          }),
        );
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const data = {};
      for (const match of body.query.matchAll(
        /target(\d+):repository\(owner:"([^"]+)",name:"([^"]+)"\)\{item:issueOrPullRequest\(number:(\d+)\)/g,
      )) {
        const [, index, , repository, value] = match;
        if (
          options.failedRepository === repository ||
          options.failedRepositories?.includes(repository)
        ) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ data, errors: [{ message: "temporary" }] }));
          return;
        }
        const number = Number(value);
        data[`target${index}`] = {
          item: {
            id:
              options.invalidGraphqlIdentity === number
                ? null
                : (options.nodeId?.(number) ?? `ISSUE_${number}`),
            state: options.reopenedNumbers?.includes(number)
              ? "CLOSED"
              : options.mergedNumbers?.includes(number)
                ? "MERGED"
                : (options.closeAfterCleanup && resolutions.length) ||
                    options.closedNumbers?.includes(number)
                  ? "CLOSED"
                  : "OPEN",
            ...(options.canonicalTarget?.(number)
              ? {
                  number: options.canonicalTarget(number).number,
                  repository: { nameWithOwner: options.canonicalTarget(number).repository },
                }
              : {}),
            ...(options.pullRequestHeads?.has(number)
              ? { headRefOid: options.pullRequestHeads.get(number) }
              : {}),
          },
        };
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data }));
      return;
    }
    if (request.url?.startsWith("/repos/")) {
      restRequests += 1;
      targetReadAuthorizations.push(request.headers.authorization);
      const number = Number(request.url.split("/").at(-1));
      restRequestsByNumber.set(number, (restRequestsByNumber.get(number) || 0) + 1);
      if (request.url.includes("/pulls/")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            node_id: options.nodeId?.(number) ?? `ISSUE_${number}`,
            state:
              !options.reopenedNumbers?.includes(number) &&
              (options.closedNumbers?.includes(number) || options.mergedNumbers?.includes(number))
                ? "closed"
                : "open",
            head: {
              sha:
                canonicalRecordRequests.length > 0 &&
                options.pullRequestHeadsAfterEvidence?.has(number)
                  ? options.pullRequestHeadsAfterEvidence.get(number)
                  : options.pullRequestHeads?.get(number),
            },
          }),
        );
        return;
      }
      if (
        ((options.failedRepository || options.failedRepositories) &&
          [options.failedRepository, ...(options.failedRepositories ?? [])].some(
            (repository) => repository && request.url.includes(`/${repository}/issues/`),
          )) ||
        ((options.failTargetOnInspection === number ||
          options.failTargetsOnInspection?.includes(number)) &&
          restRequestsByNumber.get(number) >= 2) ||
        (options.failTargetAfterCleanup === number && resolutions.length >= 2)
      ) {
        response.writeHead(options.failedStatus ?? 503, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            message: options.throttleFailures
              ? "API rate limit exceeded for installation"
              : options.failedStatus === 403
                ? "Resource not accessible by integration"
                : "temporary",
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          state:
            options.identityState?.(number) ??
            (options.reopenedNumbers?.includes(number)
              ? "open"
              : (options.closeAfterCleanup && resolutions.length) ||
                  options.mergedNumbers?.includes(number) ||
                  options.closedNumbers?.includes(number)
                ? "closed"
                : "open"),
          node_id: options.nodeId?.(number) ?? `ISSUE_${number}`,
          ...(options.canonicalTarget?.(number)
            ? {
                number: options.canonicalTarget(number).number,
                repository_url: `https://api.github.com/repos/${options.canonicalTarget(number).repository}`,
              }
            : {}),
          ...(options.pullRequestHeads?.has(number) ? { number, pull_request: {} } : {}),
        }),
      );
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (request.url?.endsWith("/list")) {
      inventoryRequests += 1;
      const openRows = rows.filter((entry) => entry.status === "open");
      const start = options.pageSize ? Number(body.cursor || 0) : 0;
      const selectedRows = options.pageSize
        ? openRows.slice(start, start + options.pageSize)
        : openRows;
      const next =
        options.pageSize && start + selectedRows.length < openRows.length
          ? String(start + selectedRows.length)
          : null;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          dead_letters: selectedRows,
          next_cursor: next,
        }),
      );
      return;
    }
    if (request.url?.endsWith("/resolve") && duplicateFailurePending) {
      duplicateFailurePending = false;
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "temporary" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url?.endsWith("/recover-fresh")) {
      recoveries.push(body);
      const skipped = options.skippedFirstRecovery === true && recoveries.length === 1;
      for (const [index, id] of body.ids.entries()) {
        const selected = rows.find((entry) => entry.dead_letter_id === id);
        if (selected && !(skipped && index === 0)) selected.status = "resolved";
      }
      const unparked = options.unparkAliasOnRecovery && recoveries.length === 1 ? 1 : 0;
      if (unparked) rows.push({ ...options.unparkAliasOnRecovery });
      response.end(
        JSON.stringify({
          ok: true,
          recovered: body.ids.length - Number(skipped),
          deduped: 0,
          skipped: skipped ? 1 : 0,
          unparked,
        }),
      );
      return;
    }
    resolutions.push(body);
    if (options.malformedGuardIds?.some((id) => body.ids.includes(id))) {
      response.end(JSON.stringify({ ok: true, resolved: 0, skipped: 0, unparked: 0 }));
      return;
    }
    if (options.blockedCleanupIds?.some((id) => body.ids.includes(id))) {
      response.end(
        JSON.stringify({ ok: true, resolved: 0, skipped: body.ids.length, unparked: 0 }),
      );
      return;
    }
    if (duplicateSkipsRemaining > 0 || options.skipCleanupAtResolution === resolutions.length) {
      if (duplicateSkipsRemaining > 0) duplicateSkipsRemaining -= 1;
      for (const id of body.ids) {
        const selected = rows.find((entry) => entry.dead_letter_id === id);
        if (selected) selected.status = "resolved";
      }
      response.end(
        JSON.stringify({ ok: true, resolved: 0, skipped: body.ids.length, unparked: 0 }),
      );
      return;
    }
    if (options.nonAtomicFirstCleanup && resolutions.length === 1) {
      response.end(
        JSON.stringify({ ok: true, resolved: 1, skipped: body.ids.length - 1, unparked: 0 }),
      );
      return;
    }
    for (const id of body.ids) {
      const selected = rows.find((entry) => entry.dead_letter_id === id);
      if (selected) selected.status = "resolved";
    }
    const unparked = options.unparkAliasOnResolve && resolutions.length === 1 ? 1 : 0;
    if (unparked) rows.push({ ...options.unparkAliasOnResolve });
    response.end(JSON.stringify({ ok: true, resolved: body.ids.length, skipped: 0, unparked }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const directory = await mkdtemp(join(tmpdir(), "clawsweeper-dlq-scenario-"));
  const args = ["--action", "reconcile"];
  if (options.execute !== false) args.push("--execute");
  if (!options.omitLimits) {
    args.push(
      "--max-targets",
      String(options.maxTargets ?? 10),
      "--max-recoveries",
      String(options.maxRecoveries ?? 10),
    );
  }
  try {
    const first = await runOperator(
      [...args, "--output", join(directory, "first.json")],
      `http://127.0.0.1:${address.port}`,
      secret,
      options.operatorEnv,
    );
    const second = options.repeat
      ? await runOperator(
          [...args, "--output", join(directory, "second.json")],
          `http://127.0.0.1:${address.port}`,
          secret,
          options.operatorEnv,
        )
      : null;
    if (first.code === 0) {
      assert.doesNotMatch(first.stderr, /reconcile_skip_accounting_inconsistent/);
    }
    if (second?.code === 0) {
      assert.doesNotMatch(second.stderr, /reconcile_skip_accounting_inconsistent/);
    }
    return {
      first,
      second,
      recoveries,
      resolutions,
      inventoryRequests,
      graphqlRequests,
      restRequests,
      canonicalRecordRequests,
      targetReadAuthorizations,
      installationRequests,
      tokenMintRequests,
    };
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function canonicalRecordEnvelope(repository, number, headSha, overrides = {}) {
  const fields = {
    number: String(number),
    repository,
    type: "pull_request",
    pull_head_sha: headSha,
    review_status: "complete",
    ...overrides,
  };
  const content = `---\n${Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n")}\n---\n\nCanonical review.\n`;
  return {
    content,
    digest: createHash("sha256").update(content).digest("hex"),
    revision: 2,
    updatedAt: "2026-08-12T23:00:00.000Z",
  };
}

test("operator inventories every page, signs requests, and reports unique targets", async () => {
  const secret = "test-dead-letter-secret";
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    assert.equal(request.headers["x-clawsweeper-exact-review-signature"], expected);
    const payload = JSON.parse(body);
    requests.push({ url: request.url, payload });
    const secondPage = payload.cursor === "dlq-2";
    const deadLetters = secondPage
      ? [
          row(
            "dlq-3",
            "publication:3",
            1,
            "retry_exhausted",
            false,
            "target_not_enabled",
            "openclaw/repo#2",
          ),
        ]
      : [
          row("dlq-1", "publication:1", 1, "state_contention", true, "eligible", "openclaw/repo#1"),
          row(
            "dlq-2",
            "publication:2",
            2,
            "state_contention",
            false,
            "publication_item_active",
            "OpenClaw/Repo#1",
          ),
        ];
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        dead_letters: deadLetters,
        next_cursor: secondPage ? null : "dlq-2",
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const directory = await mkdtemp(join(tmpdir(), "clawsweeper-dlq-"));
  const output = join(directory, "inventory.json");
  try {
    const result = await runOperator(
      ["--action", "inventory", "--output", output],
      `http://127.0.0.1:${address.port}`,
      secret,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(requests.length, 2);
    assert.deepEqual(
      requests.map((entry) => entry.url),
      ["/internal/exact-review/dead-letters/list", "/internal/exact-review/dead-letters/list"],
    );
    const inventory = JSON.parse(await readFile(output, "utf8"));
    assert.deepEqual(inventory.summary, {
      rows: 3,
      unique_publication_keys: 3,
      duplicate_publication_rows: 0,
      unique_target_keys: 2,
      duplicate_target_key_rows: 1,
      unmapped_target_rows: 0,
      eligible_fresh_recovery_rows: 1,
      eligible_fresh_recovery_target_keys: 1,
      by_reason: { retry_exhausted: 1, state_contention: 2 },
      recovery_reasons: {
        eligible: 1,
        publication_item_active: 1,
        target_not_enabled: 1,
      },
    });
    assert.equal(inventory.dead_letters[0].item, undefined);
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("operator previews by default and caps mutations at two audited ids", async () => {
  const secret = "test-dead-letter-secret";
  let mutations = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.url?.toLowerCase().startsWith("/repos/openclaw/repo/issues/")) {
      const number = Number(request.url.split("/").at(-1));
      assert.equal(request.headers.authorization, "Bearer test-target-app-token");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          node_id: `ISSUE_${number}`,
          state: number === 2 ? "closed" : "open",
        }),
      );
      return;
    }
    if (request.url?.endsWith("/recover-fresh")) {
      mutations += 1;
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          recovered: payload.idempotency_key === "operator:bad" ? "1" : 1,
          deduped: 0,
          skipped: 0,
          unparked: 0,
          item: { secret: "must not reach stdout" },
        }),
      );
      return;
    }
    if (request.url?.endsWith("/resolve")) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "internal", secret: "must not reach stderr" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        dead_letters: [
          row("dlq-1", "publication:1", 1, "state_contention", true, "eligible", "openclaw/repo#1"),
          row("dlq-2", "publication:2", 1, "state_contention", true, "eligible", "openclaw/repo#1"),
          row("dlq-3", "publication:3", 1, "state_contention", true, "eligible", "openclaw/repo#2"),
          row("dlq-5", "publication:5", 1, "state_contention", true, "eligible", "OpenClaw/Repo#1"),
          row(
            "dlq-4",
            "publication:4",
            1,
            "tuple_protocol_invalid",
            false,
            "invalid_dead_letter_item",
            null,
          ),
        ],
        next_cursor: null,
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const directory = await mkdtemp(join(tmpdir(), "clawsweeper-dlq-"));
  try {
    const result = await runOperator(
      [
        "--action",
        "recover-fresh",
        "--ids",
        "dlq-1",
        "--idempotency-key",
        "operator:test:1",
        "--output",
        join(directory, "inventory.json"),
      ],
      `http://127.0.0.1:${address.port}`,
      secret,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(mutations, 0);
    assert.equal(JSON.parse(result.stdout).dry_run, true);

    const executed = await runOperator(
      [
        "--action",
        "recover-fresh",
        "--ids",
        "dlq-1",
        "--idempotency-key",
        "operator:test:1",
        "--execute",
        "--output",
        join(directory, "inventory.json"),
      ],
      `http://127.0.0.1:${address.port}`,
      secret,
    );
    assert.equal(executed.code, 0, executed.stderr);
    assert.equal(mutations, 1);
    assert.deepEqual(JSON.parse(executed.stdout).result, {
      recovered: 1,
      deduped: 0,
      skipped: 0,
      unparked: 0,
    });
    assert.doesNotMatch(executed.stdout, /must not reach stdout/);

    const malformedResponse = await runOperator(
      [
        "--action",
        "recover-fresh",
        "--ids",
        "dlq-1",
        "--idempotency-key",
        "operator:bad",
        "--execute",
      ],
      `http://127.0.0.1:${address.port}`,
      secret,
    );
    assert.equal(malformedResponse.code, 1);
    assert.match(malformedResponse.stderr, /mutation response has invalid recovered count/);

    const invalidPreview = await runOperator(
      ["--action", "recover-fresh", "--ids", "dlq-1", "--idempotency-key", "invalid key"],
      `http://127.0.0.1:${address.port}`,
      secret,
    );
    assert.equal(invalidPreview.code, 1);
    assert.match(invalidPreview.stderr, /--idempotency-key must match/);
    assert.equal(mutations, 2);

    const duplicateTargetPreview = await runOperator(
      [
        "--action",
        "recover-fresh",
        "--ids",
        "dlq-1,dlq-2",
        "--idempotency-key",
        "operator:test:duplicate",
      ],
      `http://127.0.0.1:${address.port}`,
      secret,
    );
    assert.equal(duplicateTargetPreview.code, 1);
    assert.match(duplicateTargetPreview.stderr, /must map to distinct fresh recovery targets/);
    assert.equal(mutations, 2);

    const canonicalDuplicatePreview = await runOperator(
      [
        "--action",
        "recover-fresh",
        "--ids",
        "dlq-1,dlq-5",
        "--idempotency-key",
        "operator:test:canonical-duplicate",
      ],
      `http://127.0.0.1:${address.port}`,
      secret,
    );
    assert.equal(canonicalDuplicatePreview.code, 1);
    assert.match(canonicalDuplicatePreview.stderr, /must resolve to distinct GitHub items/);
    assert.equal(mutations, 2);

    const closedTargetPreview = await runOperator(
      ["--action", "recover-fresh", "--ids", "dlq-3", "--idempotency-key", "operator:test:closed"],
      `http://127.0.0.1:${address.port}`,
      secret,
    );
    assert.equal(closedTargetPreview.code, 1);
    assert.match(closedTargetPreview.stderr, /fresh recovery target is not open: openclaw\/repo#2/);
    assert.equal(mutations, 2);

    const unmappedResolvePreview = await runOperator(
      ["--action", "resolve", "--ids", "dlq-4", "--note", "unrecoverable legacy row"],
      `http://127.0.0.1:${address.port}`,
      secret,
    );
    assert.equal(unmappedResolvePreview.code, 0, unmappedResolvePreview.stderr);
    assert.equal(JSON.parse(unmappedResolvePreview.stdout).dry_run, true);

    const missingNotePreview = await runOperator(
      ["--action", "resolve", "--ids", "dlq-1"],
      `http://127.0.0.1:${address.port}`,
      secret,
    );
    assert.equal(missingNotePreview.code, 1);
    assert.match(missingNotePreview.stderr, /--note is required for resolve/);

    const failedResolve = await runOperator(
      ["--action", "resolve", "--ids", "dlq-1", "--note", "audited", "--execute"],
      `http://127.0.0.1:${address.port}`,
      secret,
    );
    assert.equal(failedResolve.code, 1);
    assert.match(failedResolve.stderr, /dead-letters\/resolve returned 500/);
    assert.doesNotMatch(failedResolve.stderr, /must not reach stderr/);

    const rejected = await runOperator(
      ["--action", "resolve", "--ids", "1,2,3", "--note", "audited"],
      `http://127.0.0.1:${address.port}`,
      secret,
    );
    assert.equal(rejected.code, 1);
    assert.match(rejected.stderr, /between 1 and 2 --ids/);
    assert.match(rejected.stderr, /\[exact-review-dead-letter-operator\] FAILED \(exit 1\)$/m);
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function row(
  id,
  key,
  revision,
  reason,
  eligible,
  recoveryReason,
  recoveryItemKey = `${key}:fresh`,
) {
  return {
    dead_letter_id: id,
    item_key: key,
    revision,
    reason_code: reason,
    attempts: 3,
    status: "open",
    item: { secret: "must not be copied" },
    diagnostic: {
      first_failed_at: "2026-07-23T00:00:00.000Z",
      last_failed_at: "2026-07-24T00:00:00.000Z",
      error_fingerprint: "abc",
    },
    fresh_recovery: {
      eligible,
      reason: recoveryReason,
      item_key: recoveryItemKey,
    },
  };
}

function assertSkipAccountingComplete(summary) {
  assert.equal(
    Object.values(summary.skip_reasons).reduce((total, count) => total + count, 0),
    summary.skipped_targets,
  );
}

function parkedRow(itemKey, targetRepo, itemNumber, updatedAtMs) {
  return {
    item_key: itemKey,
    revision: 1,
    target_repo: targetRepo,
    item_number: itemNumber,
    item_kind: "issue",
    parked_reason: "review_retry_exhausted",
    parked_recovery_attempts: 3,
    first_failed_at: "2026-08-09T00:00:00.000Z",
    last_failure_reason: "review_retry_exhausted",
    source_head_sha: null,
    source_base_sha: null,
    source_is_draft: null,
    source_content_revision: null,
    source_updated_at: new Date(updatedAtMs).toISOString(),
    retry_policy_epoch: "1",
    retry_policy_changed: false,
    updated_at: new Date(updatedAtMs).toISOString(),
    updated_at_ms: updatedAtMs,
  };
}

function runOperator(args, queueUrl, secret, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["scripts/exact-review-dead-letter-operator.mjs", ...args],
      {
        env: {
          ...process.env,
          EXACT_REVIEW_QUEUE_URL: queueUrl,
          CLAWSWEEPER_WEBHOOK_SECRET: secret,
          GITHUB_API_URL: queueUrl,
          EXACT_REVIEW_TARGET_TOKEN_MODE: "actions",
          GH_TOKEN: "test-target-app-token",
          GITHUB_TOKEN: "test-github-token",
          ...extraEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
