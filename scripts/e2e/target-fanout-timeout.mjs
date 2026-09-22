#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Real gh uses its supported Unix-socket transport; no live GitHub call or dispatch.
assert.notEqual(process.platform, "win32", "proof requires POSIX process groups and Unix sockets");
assert.ok(
  process.argv[2],
  "usage: node scripts/e2e/target-fanout-timeout.mjs /absolute/native/gh [--baseline]",
);
const gh = realpathSync(process.argv[2]);
const baseline = process.argv[3] === "--baseline";
const root = mkdtempSync("/tmp/fanout-proof-");
const repo = fileURLToPath(new URL("../../", import.meta.url));
const owner = new URL("../../dist/repair/target-fanout.js", import.meta.url).href;
const socket = join(root, "api.sock");
const env = {
  PATH: process.env.PATH,
  HOME: root,
  GH_BIN: gh,
  GH_BIN_ARGS: "[]",
  GH_CONFIG_DIR: join(root, "gh"),
  GH_HOST: "127.0.0.1",
  GH_ENTERPRISE_TOKEN: "synthetic-offline-token",
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
  GH_TELEMETRY: "0",
  CLAWSWEEPER_INVENTORY_TOKEN_OPENCLAW: "synthetic-offline-token",
  CLAWSWEEPER_GH_COMMAND_TIMEOUT_MS: "30000",
  CLAWSWEEPER_CODE_ROOT: repo,
};
mkdirSync(env.GH_CONFIG_DIR);
writeFileSync(join(env.GH_CONFIG_DIR, "config.yml"), `http_unix_socket: ${socket}\n`);
const ghVersion = execFileSync(gh, ["--version"], { env, encoding: "utf8" }).split("\n")[0];
assert.match(execFileSync(gh, ["config", "--help"], { env, encoding: "utf8" }), /http_unix_socket/);
let stall = false;
const requests = [];
const server = http.createServer((request, response) => {
  requests.push({ method: request.method, path: request.url });
  if (stall) return;
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      repositories: [
        {
          full_name: "openclaw/clawhub",
          archived: false,
          disabled: false,
          fork: false,
          has_issues: true,
          visibility: "public",
          default_branch: "main",
        },
      ],
    }),
  );
});
server.listen(socket);
await once(server, "listening");
try {
  for (stall of [false, true]) {
    requests.length = 0;
    const started = Date.now();
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { loadEligibleRepositories, readInventoryConfig } from ${JSON.stringify(owner)};
      try {
        console.log(JSON.stringify({ repositories: await loadEligibleRepositories(readInventoryConfig(), ["openclaw"]) }));
      } catch (error) {
        console.log(JSON.stringify({ error: error.code }));
        process.exitCode = 1;
      }
    `,
      ],
      { cwd: repo, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    let watchdog = false;
    const timer = setTimeout(
      () => {
        watchdog = true;
        process.kill(-child.pid, "SIGKILL");
      },
      stall ? 36_000 : 10_000,
    );
    let exit;
    try {
      exit = await once(child, "close");
    } finally {
      clearTimeout(timer);
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
    const elapsedMs = Date.now() - started;
    assert.deepEqual(requests, [
      { method: "GET", path: "/api/v3/installation/repositories?per_page=100" },
    ]);
    const result = stdout.trim() ? JSON.parse(stdout) : null;
    if (!stall) {
      assert.deepEqual(exit, [0, null], stderr);
      assert.equal(watchdog, false);
      assert.deepEqual(result.repositories, [
        { targetRepo: "openclaw/clawhub", defaultBranch: "main", visibility: "PUBLIC" },
      ]);
    } else if (baseline) {
      assert.equal(watchdog, true, "baseline must outlive the configured 30-second budget");
      assert.deepEqual(exit, [null, "SIGKILL"]);
      assert.equal(result, null);
    } else {
      assert.equal(watchdog, false, "production timeout must win without watchdog intervention");
      assert.deepEqual(exit, [1, null], stderr);
      assert.deepEqual(result, { error: "ETIMEDOUT" });
      assert.ok(elapsedMs >= 29_000 && elapsedMs < 36_000, `unexpected timeout ${elapsedMs}ms`);
    }
    console.log(
      JSON.stringify({
        baseline,
        scenario: stall ? "stalled" : "healthy",
        gh,
        ghVersion,
        elapsedMs,
        watchdog,
        requests,
        result,
      }),
    );
  }
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
