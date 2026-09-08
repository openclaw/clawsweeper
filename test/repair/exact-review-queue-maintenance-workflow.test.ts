import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import YAML from "yaml";
import { stableJson } from "../../dist/stable-json.js";

const path = ".github/workflows/exact-review-queue-maintenance.yml";
const source = readFileSync(path, "utf8");
const cliSource = readFileSync("src/repair/exact-review-queue-maintenance.ts", "utf8");
const workflow = YAML.parse(source) as {
  on: { schedule?: unknown; workflow_dispatch: { inputs: Record<string, unknown> } };
  concurrency: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<
    string,
    {
      if?: string;
      env?: Record<string, string>;
      permissions?: Record<string, string>;
      steps: Array<{
        name?: string;
        if?: string;
        uses?: string;
        with?: Record<string, unknown>;
        env?: Record<string, string>;
        run?: string;
      }>;
    }
  >;
};

test("queue maintenance is explicit, bounded, and non-cancelling", () => {
  assert.equal(workflow.on.schedule, undefined);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), [
    "mode",
    "execute",
    "passes",
    "max_items",
    "producer_run_id",
    "artifact_id",
    "publication_key_sha256",
    "queue_revision",
    "reviewed_plan_sha256",
  ]);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.max_items, {
    description: "Maximum reconciliation candidates to inspect",
    required: true,
    type: "number",
    default: 1,
  });
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  const maintenance = workflow.jobs.reconcile!.steps.find(
    (step) => step.name === "Preview or reconcile historical publication lineages",
  );
  assert.equal(maintenance?.env?.EXECUTE, "${{ inputs.execute }}");
  assert.equal(maintenance?.env?.PASSES, "${{ inputs.passes }}");
  assert.equal(maintenance?.env?.MAX_ITEMS, "${{ inputs.max_items }}");
  const run = maintenance?.run || "";
  assert.match(run, /repair:exact-review-queue-maintenance/);
  assert.match(run, /--max-items "\$MAX_ITEMS"/);
  assert.match(run, /args\+=\(--apply\)/);
  assert.match(run, /--passes "\$PASSES"/);
  assert.match(cliSource, /requestedPasses = integerArg\("--passes", 1, 1, 100\)/);
  assert.match(cliSource, /effectivePasses: 1/);
  assert.doesNotMatch(cliSource, /for \(let pass/);
  assert.doesNotMatch(source, /schedule:/);
});

test("retirement workflow executes isolated preview and apply argument routes", async (t) => {
  const job = workflow.jobs["retire-closed-publication"]!;
  assert.equal(
    job.if,
    "${{ inputs.mode == 'retire-closed-publication' && github.ref == 'refs/heads/main' }}",
  );
  assert.equal(
    workflow.jobs.reconcile?.if,
    "${{ inputs.mode == 'reconcile' || inputs.mode == '' }}",
  );
  assert.deepEqual(job.permissions, { contents: "read", actions: "read" });
  assert.equal(job.env, undefined);
  assert.equal(job.steps[0]?.with?.ref, "${{ github.sha }}");
  assert.equal(job.steps[0]?.with?.["persist-credentials"], false);
  assert.equal(workflow.jobs.reconcile?.env?.CLAWSWEEPER_WEBHOOK_SECRET, undefined);
  const prepare = job.steps.find((step) => step.name === "Prepare closed publication retirement")!;
  const apply = job.steps.find(
    (step) => step.name === "Assert reviewed closed publication retirement",
  )!;
  assert.equal(apply.if, "${{ inputs.execute }}");
  assert.equal(prepare.env?.CLAWSWEEPER_WEBHOOK_SECRET, undefined);
  assert.equal(apply.env?.GH_TOKEN, undefined);
  assert.equal(apply.env?.CLAWSWEEPER_WEBHOOK_SECRET, "${{ secrets.CLAWSWEEPER_WEBHOOK_SECRET }}");
  for (const step of job.steps) assert.doesNotMatch(step.run ?? "", /\$\{\{/);
  const directory = mkdtempSync(join(tmpdir(), "clawsweeper-retirement-workflow-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(
    join(directory, "pnpm"),
    `#!${process.execPath}
console.log(JSON.stringify({args:process.argv.slice(2), secret:!!process.env.CLAWSWEEPER_WEBHOOK_SECRET, token:!!process.env.GH_TOKEN}));
`,
    { mode: 0o700 },
  );
  const base = {
    PATH: `${directory}:${process.env.PATH}`,
    RUNNER_TEMP: directory,
    PRODUCER_RUN_ID: "8001",
    ARTIFACT_ID: "9001",
    PUBLICATION_KEY_SHA256: "a".repeat(64),
    QUEUE_REVISION: "8",
    REVIEWED_PLAN_SHA256: "b".repeat(64),
  };
  const preview = JSON.parse(
    (
      await promisify(execFile)("bash", ["-euo", "pipefail", "-c", prepare.run!], {
        env: { ...base, GH_TOKEN: "synthetic-token" },
      })
    ).stdout,
  );
  assert.deepEqual(preview, {
    args: [
      "run",
      "--silent",
      "repair:exact-review-queue-maintenance",
      "retire-closed-publication",
      "--producer-run-id",
      "8001",
      "--artifact-id",
      "9001",
      "--publication-key-sha256",
      "a".repeat(64),
      "--queue-revision",
      "8",
      "--plan-file",
      join(directory, "closed-publication-retirement.json"),
    ],
    secret: false,
    token: true,
  });
  const applied = JSON.parse(
    (
      await promisify(execFile)("bash", ["-euo", "pipefail", "-c", apply.run!], {
        env: { ...base, CLAWSWEEPER_WEBHOOK_SECRET: "synthetic-secret" },
      })
    ).stdout,
  );
  assert.deepEqual(applied, {
    args: [
      "run",
      "--silent",
      "repair:exact-review-queue-maintenance",
      "retire-closed-publication",
      "--apply",
      "--reviewed-plan-sha256",
      "b".repeat(64),
      "--plan-file",
      join(directory, "closed-publication-retirement.json"),
    ],
    secret: true,
    token: false,
  });
});

test("maintenance CLI signs one HTTPS dry run, redacts identities, and refuses redirects", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "clawsweeper-maintenance-tls-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const key = join(directory, "key.pem");
  const cert = join(directory, "cert.pem");
  const config = join(directory, "openssl.cnf");
  writeFileSync(
    config,
    "[req]\ndistinguished_name=dn\n[dn]\n[extensions]\nsubjectAltName=IP:127.0.0.1\n",
  );
  await promisify(execFile)(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-config",
      config,
      "-extensions",
      "extensions",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { timeout: 10_000 },
  );
  const secret = "synthetic-maintenance-secret";
  let calls = 0;
  let redirectedCalls = 0;
  let redirect = false;
  let retirementCalls = 0;
  let retirementMode = "success";
  const server = createServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    async (request, response) => {
      if (request.url === "/internal/exact-review/lifecycle/terminal-disposition") {
        let body = "";
        for await (const chunk of request) body += chunk;
        retirementCalls += 1;
        assert.equal(request.method, "POST");
        assert.equal(
          request.headers["x-clawsweeper-exact-review-signature"],
          `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
        );
        const payload = JSON.parse(body);
        assert.equal(payload.kind, "target_closed");
        assert.equal(payload.revision, 8);
        assert.equal(payload.fence_key, "openclaw/openclaw#770700@publish:8001:1");
        if (retirementMode === "redirect") {
          response.writeHead(307, { location: "/private-redirect-sentinel" }).end();
        } else if (retirementMode === "500") {
          response.writeHead(500).end("private-response-sentinel");
        } else {
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              ok: true,
              lifecycle_state: retirementMode === "array" ? ["target_closed"] : "target_closed",
              acknowledgement_state: "pending",
              private: "private-response-sentinel",
            }),
          );
        }
        return;
      }
      if (request.url !== "/internal/exact-review/publications/reconcile") {
        redirectedCalls += 1;
        response.writeHead(500).end();
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      calls += 1;
      assert.equal(request.method, "POST");
      assert.deepEqual(JSON.parse(body), { apply: false, max_items: 1 });
      assert.equal(
        request.headers["x-clawsweeper-exact-review-signature"],
        `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      );
      if (redirect) {
        response.writeHead(307, { location: "/private-redirect-sentinel" }).end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          apply: false,
          scanned: 1,
          eligible: 1,
          changed: 0,
          eligible_remaining: 1,
          protected_batch_items: 0,
          oldest_eligible_age_seconds: 60,
          oldest_remaining_age_seconds: 60,
          sample: [
            {
              item_key: "private-item-sentinel",
              target_key: "private-target-sentinel",
              retained_item_key: "private-retained-sentinel",
              queue_revision: calls === 1 ? 8 : 9,
              reason: "stale_revision",
              publication_revision: 7,
              superseded_by_revision: 11,
              lineage_claim_generation: 99,
              command_context: true,
              acknowledgement_state: "unavailable",
              acknowledgement_unavailable_reason: "terminal_missing",
              supersede_safe: false,
              successor_fence_state: "missing",
              producer_run_id: "private-producer-sentinel",
              producer_run_attempt: 1,
              private_detail: "private-detail-sentinel",
            },
          ],
        }),
      );
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const endpoint = `https://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const run = () =>
    promisify(execFile)(
      process.execPath,
      ["dist/repair/exact-review-queue-maintenance.js", "--max-items", "1", "--passes", "3"],
      {
        timeout: 10_000,
        env: {
          PATH: process.env.PATH,
          NODE_EXTRA_CA_CERTS: cert,
          EXACT_REVIEW_QUEUE_URL: endpoint,
          CLAWSWEEPER_WEBHOOK_SECRET: secret,
        },
      },
    );
  const { stdout, stderr } = await run();
  const output = JSON.parse(stdout);
  assert.equal(calls, 1);
  assert.equal(output.apply, false);
  assert.equal(output.effectivePasses, 1);
  assert.equal(output.changed, 0);
  assert.deepEqual(output.sample, [
    {
      identity_hash: "17f815f7c65a7e226b2b54b539f43e170734d435a5068a4af3a9e15c64a9fb9c",
      queueRevision: 8,
      reason: "stale_revision",
      publicationRevision: 7,
      supersededByRevision: 11,
      commandContext: true,
      acknowledgementState: "unavailable",
      acknowledgementUnavailableReason: "terminal_missing",
      supersedeSafe: false,
      successorFenceState: "missing",
    },
  ]);
  assert.doesNotMatch(stdout + stderr, /private-.*-sentinel|synthetic-maintenance-secret/);
  assert.match(stderr, /clamped to one observed pass/);
  const repeated = await run();
  const next = JSON.parse(repeated.stdout).sample[0];
  assert.equal(calls, 2);
  assert.equal(next.queueRevision, 9);
  assert.equal(next.identity_hash, output.sample[0].identity_hash);
  assert.doesNotMatch(
    repeated.stdout + repeated.stderr,
    /private-.*-sentinel|synthetic-maintenance-secret/,
  );
  redirect = true;
  await assert.rejects(run(), (error: Error & { stdout: string; stderr: string }) => {
    assert.equal(error.stdout, "");
    assert.match(error.stderr, /failed \(network_error\)/);
    assert.doesNotMatch(error.stderr, /private-.*-sentinel|synthetic-maintenance-secret/);
    return true;
  });
  assert.equal(calls, 3);
  assert.equal(redirectedCalls, 0);

  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const plan = {
    version: 1,
    workflowSha: "d".repeat(40),
    artifactId: 9001,
    artifactSha256: "e".repeat(64),
    producerRunId: 8001,
    producerRunAttempt: 1,
    producerSourceSha: "a".repeat(40),
    sourceRevision: 7,
    claimGeneration: 1,
    queueRevision: 8,
    canonicalTargetKey: "openclaw/openclaw#770700",
    publicationKey: "openclaw/openclaw#770700@publish:8001:1",
    publicationKeySha256: hash("openclaw/openclaw#770700@publish:8001:1"),
    targetNodeId: "private-node-sentinel",
    mergedAt: "2026-08-18T14:00:00Z",
    mergeCommitSha: "c".repeat(40),
  };
  writeFileSync(join(directory, "closed-publication-retirement.json"), JSON.stringify(plan));
  assert.equal((await promisify(execFile)("pnpm", ["--version"])).stdout.trim(), "11.10.0");
  const env = {
    PATH: process.env.PATH,
    NODE_EXTRA_CA_CERTS: cert,
    EXACT_REVIEW_QUEUE_URL: endpoint,
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    GITHUB_SHA: plan.workflowSha,
    RUNNER_TEMP: directory,
    REVIEWED_PLAN_SHA256: hash(stableJson(plan)),
  };
  const retirement = workflow.jobs["retire-closed-publication"]!;
  const execute = retirement.steps.find(
    (step) => step.name === "Assert reviewed closed publication retirement",
  )!;
  const prepare = retirement.steps.find(
    (step) => step.name === "Prepare closed publication retirement",
  )!;
  const executeWorkflowStep = () =>
    promisify(execFile)("bash", ["-euo", "pipefail", "-c", execute.run!], {
      env,
      timeout: 10_000,
    });
  await assert.rejects(
    promisify(execFile)("bash", ["-euo", "pipefail", "-c", prepare.run!], {
      env: {
        ...env,
        GH_TOKEN: "synthetic-token",
        PRODUCER_RUN_ID: "0",
        ARTIFACT_ID: "9001",
        PUBLICATION_KEY_SHA256: plan.publicationKeySha256,
        QUEUE_REVISION: "8",
      },
      timeout: 10_000,
    }),
    (error: Error & { stdout: string; stderr: string }) => {
      assert.match(error.stderr, /"status":"retirement_failed"/);
      assert.doesNotMatch(error.stdout + error.stderr, /private-.*-sentinel|synthetic-token/);
      return true;
    },
  );
  for (const args of [
    ["unknown-mode"],
    ["--", "retire-closed-publication"],
    ["--max-items", "1", "unknown-mode"],
  ]) {
    await assert.rejects(
      promisify(execFile)(
        "pnpm",
        ["run", "--silent", "repair:exact-review-queue-maintenance", ...args],
        { env, timeout: 10_000 },
      ),
      (error: Error & { stderr: string }) => {
        assert.match(error.stderr, /invalid arguments/);
        return true;
      },
    );
  }
  assert.equal(calls, 3);
  assert.equal(retirementCalls, 0);
  const applied = await executeWorkflowStep();
  assert.equal(JSON.parse(applied.stdout).status, "asserted");
  assert.equal(retirementCalls, 1);
  assert.doesNotMatch(
    applied.stdout + applied.stderr,
    /private-.*-sentinel|synthetic-maintenance-secret/,
  );
  for (const mode of ["redirect", "500", "array"]) {
    retirementMode = mode;
    const before = retirementCalls;
    await assert.rejects(
      executeWorkflowStep(),
      (error: Error & { stdout: string; stderr: string }) => {
        assert.match(error.stderr, /"status":"retirement_failed"/);
        assert.doesNotMatch(
          error.stdout + error.stderr,
          /private-.*-sentinel|synthetic-maintenance-secret/,
        );
        return true;
      },
    );
    assert.equal(retirementCalls, before + 1);
  }
  assert.equal(calls, 3);
  assert.equal(redirectedCalls, 0);
});
