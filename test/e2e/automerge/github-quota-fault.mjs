import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);

export function runGitHubQuotaFault({ runtimeRoot, artifacts, fixture }) {
  runtimeRoot = fs.realpathSync(runtimeRoot);
  const root = fs.mkdtempSync("/tmp/clawsweeper-quota-");
  const ghBinary = execFileSync("which", ["gh"], { encoding: "utf8" }).trim();
  const ghVersion = execFileSync(ghBinary, ["--version"], { encoding: "utf8" }).split("\n")[0];
  const results = [];

  try {
    for (const status of [403, 429]) {
      const workRoot = path.join(root, String(status));
      const socket = path.join(root, `${status}.sock`);
      const ready = path.join(workRoot, "server-ready");
      const requests = path.join(workRoot, "requests.jsonl");
      const output = path.join(workRoot, "github-output");
      const batch = path.join(workRoot, "batch.json");
      const artifactDir = path.join(workRoot, "artifacts", "event");
      fs.mkdirSync(artifactDir, { recursive: true });
      fs.writeFileSync(path.join(artifactDir, "42.md"), quotaProofReport());

      const env = {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: workRoot,
        GH_BIN: ghBinary,
        GH_BIN_ARGS: "[]",
        GH_CONFIG_DIR: path.join(workRoot, "gh-config"),
        GH_ENTERPRISE_TOKEN: "offline-quota-proof-token",
        GH_HOST: "127.0.0.1",
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
        GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
        GH_TELEMETRY: "0",
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
        CLAWSWEEPER_CODE_ROOT: runtimeRoot,
        CLAWSWEEPER_GH_RETRY_ATTEMPTS: "12",
        CLAWSWEEPER_ACTION_LEDGER_DISABLED: "1",
        EXACT_EVENT_PUBLICATION: "true",
        EXACT_REVIEW_BATCH_MUTATION_OUTPUT: batch,
        EXACT_REVIEW_WORK_ROOT: workRoot,
        GITHUB_OUTPUT: output,
        ITEM_NUMBER: "42",
        TARGET_REPO: "openclaw/openclaw",
      };

      const help = execFileSync(ghBinary, ["config", "--help"], { env, encoding: "utf8" });
      assert.match(help, /http_unix_socket/, "installed GitHub CLI lacks local HTTP transport");
      execFileSync(ghBinary, ["config", "set", "http_unix_socket", socket], { env });

      const serverLog = fs.openSync(path.join(artifacts, `github-${status}.server.log`), "w");
      const server = spawn(
        process.execPath,
        [self, "--serve", socket, ready, requests, String(status)],
        {
          env,
          stdio: ["ignore", serverLog, serverLog],
        },
      );
      fs.closeSync(serverLog);

      try {
        waitForServer(server, ready);
        const startedAt = Date.now();
        const publisher = spawnSync(
          process.execPath,
          [path.join(runtimeRoot, "dist", "repair", "publish-event-result.js")],
          { cwd: workRoot, env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
        );
        fs.writeFileSync(
          path.join(artifacts, `github-${status}.stdout.log`),
          publisher.stdout ?? "",
        );
        fs.writeFileSync(
          path.join(artifacts, `github-${status}.stderr.log`),
          publisher.stderr ?? "",
        );
        if (publisher.error) throw publisher.error;
        assert.equal(publisher.status, 1, `HTTP ${status} publisher must fail honestly`);

        const calls = fs.readFileSync(requests, "utf8").trim().split("\n").map(JSON.parse);
        assert.equal(calls.length, 1, `HTTP ${status} must stop after its first real request`);
        assert.equal(calls[0].method, "GET");
        assert.match(calls[0].path, /\/api\/v3\/repos\/openclaw\/openclaw\/issues\/42$/);
        assert.equal(calls[0].authenticated, true);
        assert.equal(calls.filter((call) => call.method === "DELETE").length, 0);

        const fields = Object.fromEntries(
          fs
            .readFileSync(output, "utf8")
            .trim()
            .split("\n")
            .map((line) => {
              const separator = line.indexOf("=");
              return [line.slice(0, separator), line.slice(separator + 1)];
            }),
        );
        const durable = JSON.parse(fs.readFileSync(batch, "utf8"));
        assert.equal(fields.completion_kind, "retryable_failure");
        assert.equal(fields.failure_kind, "github_rate_limit");
        assert.equal(fields.reason_code, "github_rate_limit");
        assert.ok(Date.parse(fields.retry_at) >= startedAt + 59_000);
        assert.equal(durable.kind, "retryable_failure");
        assert.equal(durable.reasonCode, "github_rate_limit");

        results.push({
          http_status: status,
          requests: calls.length,
          request: calls[0],
          publisher_exit: publisher.status,
          completion_kind: fields.completion_kind,
          failure_kind: fields.failure_kind,
          retry_at: fields.retry_at,
          batch_kind: durable.kind,
          cleanup_deletes: 0,
        });
      } finally {
        server.kill();
        fs.rmSync(socket, { force: true });
      }
    }

    const summary = {
      status: "passed",
      fixture,
      scenario: "github-api-quota-fail-fast",
      container: fs.existsSync("/.dockerenv"),
      gh_version: ghVersion,
      transport: "actual gh HTTP over an owned Unix socket",
      results,
    };
    fs.writeFileSync(path.join(artifacts, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    return { status: "passed", fixture, scenario: summary.scenario, artifacts };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function quotaProofReport() {
  return [
    "---",
    "number: 42",
    "repository: openclaw/openclaw",
    "type: issue",
    "review_status: complete",
    "local_checkout_access: verified",
    "local_checkout_access_source: runner_preflight_v1",
    "decision: keep_open",
    "action_taken: kept_open",
    "item_snapshot_hash: quota-proof",
    `reviewed_at: ${new Date().toISOString()}`,
    "---",
    "",
    "# GitHub quota fault injection",
    "",
  ].join("\n");
}

function waitForServer(server, ready) {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(ready)) {
    if (server.exitCode !== null) throw new Error(`quota server exited ${server.exitCode}`);
    if (Date.now() >= deadline) throw new Error("quota HTTP server did not become ready");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === self && process.argv[2] === "--serve") {
  const [, , , socket, ready, log, rawStatus] = process.argv;
  const status = Number(rawStatus);
  const server = http.createServer((request, response) => {
    fs.appendFileSync(
      log,
      `${JSON.stringify({
        method: request.method,
        path: request.url,
        user_agent: request.headers["user-agent"],
        authenticated: Boolean(request.headers.authorization),
      })}\n`,
    );
    response.writeHead(status, {
      "content-type": "application/json",
      "retry-after": "120",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 300),
    });
    response.end(
      JSON.stringify({
        message: status === 403 ? "API rate limit exceeded for installation" : "Too Many Requests",
        status: String(status),
      }),
    );
  });
  server.listen(socket, () => fs.writeFileSync(ready, "ready\n"));
}
