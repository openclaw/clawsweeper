import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import YAML from "yaml";

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
      env: Record<string, string>;
      steps: Array<{ name?: string; env?: Record<string, string>; run?: string }>;
    }
  >;
};

test("queue maintenance is explicit, bounded, and non-cancelling", () => {
  assert.equal(workflow.on.schedule, undefined);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), [
    "execute",
    "passes",
    "max_items",
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
  const server = createServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    async (request, response) => {
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
});
