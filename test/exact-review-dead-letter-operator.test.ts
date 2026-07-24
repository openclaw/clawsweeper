import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";
import { readFileSync } from "node:fs";

const workflowPath = ".github/workflows/exact-review-dead-letter-operator.yml";
const workflowSource = readFileSync(workflowPath, "utf8");
const workflow = YAML.parse(workflowSource);

test("dead-letter workflow is manual, serialized, and bounded to safe actions", () => {
  assert.equal(workflow.on.schedule, undefined);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.action.options, [
    "inventory",
    "recover-fresh",
    "resolve",
  ]);
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.deepEqual(workflow.permissions, { contents: "read" });
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
  assert.match(operatorStep.run, /operator:\$\{GITHUB_RUN_ID\}/);
  assert.doesNotMatch(operatorStep.run, /GITHUB_RUN_ATTEMPT/);
});

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
      ? [row("dlq-3", "item:2", 1, "retry_exhausted", false, "target_not_enabled")]
      : [
          row("dlq-1", "item:1", 1, "state_contention", true, "eligible"),
          row("dlq-2", "item:1", 2, "state_contention", false, "publication_item_active"),
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
      unique_item_keys: 2,
      duplicate_revision_rows: 1,
      eligible_fresh_recovery: 1,
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
        dead_letters: [row("dlq-1", "item:1", 1, "state_contention", true, "eligible")],
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

function row(id, key, revision, reason, eligible, recoveryReason) {
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
      item_key: eligible ? `${key}:fresh` : null,
    },
  };
}

function runOperator(args, queueUrl, secret) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["scripts/exact-review-dead-letter-operator.mjs", ...args],
      {
        env: {
          ...process.env,
          EXACT_REVIEW_QUEUE_URL: queueUrl,
          CLAWSWEEPER_WEBHOOK_SECRET: secret,
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
