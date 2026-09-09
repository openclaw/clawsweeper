import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";

const execute = promisify(execFile);
const workflow = parse(await readFile(".github/workflows/sweep.yml", "utf8"));
const helper = await readFile("scripts/control-plane-curl.sh", "utf8");
const cases = [];
for (const [jobName, stepName, endpoint] of [
  ["event-review-apply", "Complete exact-review queue lease", "/internal/exact-review/complete"],
  [
    "event-review-publish",
    "Complete durable exact review publication",
    "/internal/exact-review/complete",
  ],
  [
    "event-review-terminal-finalization",
    "Requeue unobserved terminal acknowledgement",
    "/internal/exact-review/terminal-finalization/retry",
  ],
]) {
  const job = workflow.jobs[jobName];
  const step = job.steps.find((entry) => entry.name === stepName);
  assert.ok(step?.run);
  assert.match(step.if, /always\(\)/);
  for (const checkoutOutcome of ["success", "skipped", "failure"]) {
    const root = await mkdtemp(join(tmpdir(), "control-plane-cleanup-"));
    const runnerTemp = join(root, "runner-temp");
    const requests = [];
    const server = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      requests.push({ method: request.method, path: request.url, body: JSON.parse(raw) });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, requeued: true }));
    });
    await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
    try {
      await mkdir(runnerTemp);
      await writeFile(
        join(runnerTemp, "control-plane-curl.sh"),
        checkoutOutcome === "success" ? "exit 91\n" : helper,
      );
      if (checkoutOutcome !== "skipped") {
        await mkdir(join(root, "scripts"));
        // A failed checkout's partial tree must not override the validated bootstrap.
        await writeFile(
          join(root, "scripts/control-plane-curl.sh"),
          checkoutOutcome === "success" ? helper : "exit 92\n",
        );
      }
      await execute("bash", ["-c", step.run], {
        cwd: root,
        timeout: 15_000,
        env: {
          ...Object.fromEntries(Object.keys(step.env ?? {}).map((key) => [key, ""])),
          PATH: process.env.PATH,
          RUNNER_TEMP: runnerTemp,
          SOURCE_CHECKOUT_OUTCOME: checkoutOutcome,
          QUEUE_URL: `http://127.0.0.1:${server.address().port}`,
          GITHUB_OUTPUT: join(root, "output"),
          GITHUB_RUN_ID: "123",
          RUN_ATTEMPT: "1",
          QUEUE_LEASE_ID: "synthetic-lease",
          ITEM_KEY: "synthetic/repo#42",
          PROTOCOL_VERSION: "2",
          QUEUE_LEASE_REVISION: "1",
          LEASE_REVISION: "1",
          CLAIM_GENERATION: "1",
          PRIMARY_OUTCOME: "failure",
          OUTCOME: "failure",
          COMPLETION_KIND: "retryable_failure",
          REASON_CODE: "unknown_failure",
          DIRECT_PUBLICATION_ACCEPTED: "false",
          DIRECT_LIFECYCLE_REQUEUE: jobName === "event-review-publish" ? "true" : "false",
        },
      });
      assert.equal(requests.length, 1, `${jobName}/${checkoutOutcome}`);
      const request = requests[0];
      assert.equal(request.method, "POST");
      assert.equal(request.path, endpoint);
      assert.equal(request.body.lease_id, "synthetic-lease");
      assert.equal(request.body.claim_generation, 1);
      if (jobName === "event-review-publish") {
        assert.equal(request.body.direct_lifecycle_requeue, true);
        assert.equal(request.body.lifecycle_terminal_disposition, "requeue");
      }
      cases.push({
        job: jobName,
        checkout: checkoutOutcome,
        helper: checkoutOutcome === "success" ? "checkout" : "runner-temp",
        endpoint,
        requests: requests.length,
        directLifecycleRequeue: request.body.direct_lifecycle_requeue === true,
      });
    } finally {
      await new Promise((closed) => server.close(closed));
      await rm(root, { recursive: true, force: true });
    }
  }
}
console.log(
  JSON.stringify(
    {
      ok: true,
      provider: "local-shell-loopback-http",
      cases,
      limits:
        "Extracted cleanup steps and real HTTP; synthetic leases, no GitHub or production queue mutations.",
    },
    null,
    2,
  ),
);
