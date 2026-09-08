import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import YAML from "yaml";
const execute = promisify(execFile);
const workflow = YAML.parse(await fs.readFile(".github/workflows/sweep.yml", "utf8"));
const job = workflow.jobs["event-review-terminal-finalization"];
const script = job.steps.find((step) => step.id === "terminal-acknowledgement").run;
for (const [status, body, success] of [
  [409, { error: "parked_command_target_changed" }, true],
  [409, { error: "parked_command_superseded" }, true],
  [409, { error: "lease_not_active" }, true],
  [409, { error: "invalid_terminal_finalization_acknowledgement" }, false],
  [503, { error: "parked_command_target_unavailable" }, false],
  [200, { ok: true, allowed: true, acknowledgement_state: "pending", attempt_id: "ack:1" }, true],
] as const)
  test(`terminal acknowledgement workflow ${status} ${"error" in body ? body.error : "authorized"}`, async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "terminal-cancellation-workflow-"));
    const output = path.join(root, "output");
    let requests = 0;
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      const input = JSON.parse(raw);
      assert.equal(input.item_key, "terminal-finalization:synthetic/repo#1:1");
      assert.equal(req.method, "POST");
      requests++;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    try {
      const run = execute("bash", ["-euo", "pipefail", "-c", script], {
        timeout: 30000,
        env: {
          PATH: process.env.PATH,
          ITEM_KEY: "terminal-finalization:synthetic/repo#1:1",
          QUEUE_LEASE_ID: "synthetic-lease",
          LEASE_REVISION: "1",
          CLAIM_GENERATION: "1",
          RUN_ATTEMPT: "1",
          GITHUB_RUN_ID: "123",
          STATUS_MARKER: "synthetic-marker",
          STATUS_COMMENT_ID: "",
          GITHUB_OUTPUT: output,
          QUEUE_URL: `http://127.0.0.1:${address.port}`,
        },
      });
      if (success) {
        await run;
        const result = await fs.readFile(output, "utf8");
        assert.match(result, status === 409 ? /allowed=false/ : /allowed=true/);
        if (status === 409) assert.match(result, /acknowledgement_state=unavailable/);
      } else await assert.rejects(run);
      assert.equal(requests, status >= 500 ? 4 : 1);
      assert.match(
        job.steps.find((step) => step.id === "update-final-command-status").if,
        /terminal-acknowledgement.outputs.allowed == .true./,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test("terminal finalization checks eligibility before requesting target write credentials", () => {
  const admissionIndex = job.steps.findIndex((step) => step.id === "terminal-acknowledgement");
  const tokenIndex = job.steps.findIndex((step) => step.id === "target-write-token");
  const update = job.steps.find((step) => step.id === "update-final-command-status");
  assert.ok(admissionIndex >= 0 && admissionIndex < tokenIndex);
  assert.doesNotMatch(job.steps[admissionIndex].if, /target-write-token/);
  assert.match(job.steps[tokenIndex].if, /terminal-acknowledgement.outputs.allowed == .true./);
  assert.match(update.if, /target-write-token.outcome == .success./);
});
