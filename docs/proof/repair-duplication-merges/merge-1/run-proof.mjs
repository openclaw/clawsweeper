import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runMergeNotifier } from "../../../../dist/repair/notify-merge.js";

const root = process.cwd();
const baseRef = process.env.PROOF_BASE_REF || "origin/main";
const sourcePath = "src/repair/notify-merge.ts";
const currentCli = path.join(root, "dist/repair/notify-merge.js");
const artifactPath = path.join(
  root,
  "docs/proof/repair-duplication-merges/merge-1/artifacts/retry-adoption.json",
);
const idempotencyKey = "merge:openclaw/openclaw#123:merge_canonical:abc123";
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawsweeper-notify-merge-proof-"));
const requests = [];
const scenarioAttempts = new Map();

assert.equal(
  await fileExists(currentCli),
  true,
  "build the repair CLI before running this proof",
);

const server = createServer(async (request, response) => {
  const receivedAt = new Date().toISOString();
  const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
  const scenario = pathname.startsWith("/old/") ? "old" : pathname.startsWith("/new/") ? "new" : "unknown";
  const attempt = (scenarioAttempts.get(scenario) ?? 0) + 1;
  scenarioAttempts.set(scenario, attempt);
  const body = await readRequestBody(request);
  const status = attempt === 1 ? 503 : 200;
  const event = {
    scenario,
    attempt,
    received_at: receivedAt,
    method: request.method,
    pathname,
    idempotency_key: String(request.headers["idempotency-key"] ?? ""),
    body_idempotency_key: parseBodyIdempotencyKey(body),
    local_address: request.socket.localAddress,
    remote_address: request.socket.remoteAddress,
    response_status: status,
  };
  requests.push(event);
  const responseBody =
    status === 503
      ? JSON.stringify({ error: "proof_transient_503" })
      : JSON.stringify({ runId: "proof-run" });
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(responseBody),
  });
  response.end(responseBody);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
debug("listener ready");

let artifact;
try {
  const address = server.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const baselineRoot = path.join(tempRoot, "baseline");
  await mkdir(baselineRoot, { recursive: true });
  await extractGitTree(baseRef, baselineRoot);
  debug("baseline extracted");
  await symlink(path.join(root, "node_modules"), path.join(baselineRoot, "node_modules"), "dir");
  const baselineBuild = await runProcess(
    process.execPath,
    [path.join(root, "node_modules/typescript/bin/tsc"), "-p", path.join(baselineRoot, "tsconfig.repair.json")],
    { cwd: baselineRoot },
  );
  assert.equal(baselineBuild.exitCode, 0, baselineBuild.stderr || baselineBuild.stdout);
  debug("baseline built");

  const inputPath = path.join(tempRoot, "repair-apply-report.json");
  await writeFile(
    inputPath,
    `${JSON.stringify([
      {
        action: "merge_canonical",
        status: "executed",
        repo: "openclaw/openclaw",
        target: "#123",
        title: "Real socket proof",
        reason: "proof fixture",
        merge_commit_sha: "abc123",
        merged_at: "2026-08-10T00:00:00.000Z",
      },
    ], null, 2)}\n`,
  );

  const baselineCli = path.join(baselineRoot, "dist/repair/notify-merge.js");
  const oldRun = await runNotifier({
    cli: baselineCli,
    root: baselineRoot,
    scenario: "old",
    origin,
    inputPath,
  });
  debug("old notifier complete");
  const newRun = await runCurrentNotifier({
    scenario: "new",
    origin,
    inputPath,
  });
  debug("new notifier complete");

  const oldRequests = requests.filter((request) => request.scenario === "old");
  const newRequests = requests.filter((request) => request.scenario === "new");
  debug(`old run ${JSON.stringify(oldRun)}`);
  debug(`new run ${JSON.stringify(newRun)}`);
  assert.equal(oldRun.exitCode, 1, oldRun.stdout);
  assert.equal(oldRequests.length, 1);
  assert.equal(oldRequests[0].response_status, 503);
  assert.equal(newRun.exitCode, 0, newRun.stderr);
  assert.equal(newRequests.length, 2);
  assert.deepEqual(
    newRequests.map((request) => request.response_status),
    [503, 200],
  );
  assert.deepEqual(
    newRequests.map((request) => request.idempotency_key),
    [idempotencyKey, idempotencyKey],
  );
  assert(requests.every((request) => request.local_address === "127.0.0.1"));
  assert(requests.every((request) => request.remote_address === "127.0.0.1"));
  assert(requests.every((request) => request.idempotency_key === idempotencyKey));
  assert(requests.every((request) => request.body_idempotency_key === idempotencyKey));

  const oldReport = JSON.parse(await readFile(oldRun.reportPath, "utf8"));
  const newReport = JSON.parse(await readFile(newRun.reportPath, "utf8"));
  assert.equal(oldReport.failed, 1);
  assert.equal(oldReport.sent, 0);
  assert.equal(newReport.failed, 0);
  assert.equal(newReport.sent, 1);

  const siblingNotifiers = [
    "src/repair/notify-events.ts",
    "src/repair/notify-github-activity.ts",
    "src/repair/notify-maintainer-report.ts",
  ];
  for (const file of siblingNotifiers) {
    const source = await readFile(path.join(root, file), "utf8");
    assert.match(source, /postOpenClawAgentHook/);
    assert.match(source, /resolveOpenClawHookConfig/);
  }

  artifact = {
    base_ref: baseRef,
    base_sha: git("rev-parse", baseRef),
    source: {
      baseline: {
        path: sourcePath,
        sha256: sha256(await readFile(path.join(baselineRoot, sourcePath))),
        cli_sha256: sha256(await readFile(baselineCli)),
      },
      current: {
        path: sourcePath,
        sha256: sha256(await readFile(path.join(root, sourcePath))),
        cli_sha256: sha256(await readFile(currentCli)),
      },
    },
    transport: {
      kind: "real loopback HTTP socket",
      bound_address: `127.0.0.1:${address.port}`,
      requests,
    },
    old: {
      entrypoint: "baseline dist/repair/notify-merge.js",
      exit_code: oldRun.exitCode,
      outcome: "failed after one HTTP 503",
      requests: oldRequests.length,
      stdout: oldRun.stdout.trim(),
      stderr: oldRun.stderr.trim(),
    },
    new: {
      entrypoint: "runMergeNotifier (the function invoked by dist/repair/notify-merge.js main)",
      exit_code: newRun.exitCode,
      outcome: "succeeded after HTTP 503 then HTTP 200",
      requests: newRequests.length,
      stdout: newRun.stdout.trim(),
      stderr: newRun.stderr.trim(),
    },
    sibling_notifier_precedent: siblingNotifiers,
  };
  debug("artifact assembled");
} finally {
  debug("cleanup start");
  await closeServer(server);
  await rm(tempRoot, { recursive: true, force: true });
}

await mkdir(path.dirname(artifactPath), { recursive: true });
await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify(artifact, null, 2));

async function runNotifier({ cli, root: notifierRoot, scenario, origin, inputPath }) {
  const scenarioRoot = path.join(tempRoot, scenario);
  const ledgerPath = path.join(scenarioRoot, "ledger.json");
  const reportPath = path.join(scenarioRoot, "report.json");
  await mkdir(scenarioRoot, { recursive: true });
  const env = {
    ...process.env,
    CLAWSWEEPER_DISCORD_TARGET: "channel:proof",
    CLAWSWEEPER_MERGE_NOTIFY_STRICT: "1",
    CLAWSWEEPER_OPENCLAW_HOOK_RETRY_ATTEMPTS: "2",
    CLAWSWEEPER_OPENCLAW_HOOK_TIMEOUT_SECONDS: "1",
    CLAWSWEEPER_OPENCLAW_HOOK_TOKEN: "disposable-local-proof-token",
    CLAWSWEEPER_OPENCLAW_HOOK_URL: `${origin}/${scenario}`,
  };
  const result = await runProcess(
    process.execPath,
    [
      await realpath(cli),
      "--input",
      inputPath,
      "--ledger",
      ledgerPath,
      "--report",
      reportPath,
      "--strict",
    ],
    { cwd: notifierRoot, env },
  );
  return { ...result, reportPath };
}

async function runCurrentNotifier({ scenario, origin, inputPath }) {
  const scenarioRoot = path.join(tempRoot, scenario);
  const ledgerPath = path.join(scenarioRoot, "ledger.json");
  const reportPath = path.join(scenarioRoot, "report.json");
  await mkdir(scenarioRoot, { recursive: true });
  const proofEnv = {
    CLAWSWEEPER_DISCORD_TARGET: "channel:proof",
    CLAWSWEEPER_MERGE_NOTIFY_STRICT: "1",
    CLAWSWEEPER_OPENCLAW_HOOK_RETRY_ATTEMPTS: "2",
    CLAWSWEEPER_OPENCLAW_HOOK_TIMEOUT_SECONDS: "1",
    CLAWSWEEPER_OPENCLAW_HOOK_TOKEN: "disposable-local-proof-token",
    CLAWSWEEPER_OPENCLAW_HOOK_URL: `${origin}/${scenario}`,
  };
  const previous = new Map(Object.keys(proofEnv).map((key) => [key, process.env[key]]));
  Object.assign(process.env, proofEnv);
  const logs = [];
  try {
    const summary = await runMergeNotifier(
      [
        "--input",
        inputPath,
        "--ledger",
        ledgerPath,
        "--report",
        reportPath,
        "--strict",
      ],
      { log: (line) => logs.push(line) },
    );
    return {
      exitCode: summary.exitCode,
      signal: null,
      stdout: logs.join("\n"),
      stderr: "",
      reportPath,
    };
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function extractGitTree(ref, destination) {
  const archivePath = path.join(tempRoot, "baseline.tar");
  execFileSync("git", ["archive", "--format=tar", "-o", archivePath, ref], { cwd: root });
  execFileSync("tar", ["-x", "-f", archivePath, "-C", destination]);
  await rm(archivePath);
}

function runProcess(command, args, options = {}) {
  return collectProcess(
    spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

function collectProcess(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }));
  });
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function parseBodyIdempotencyKey(body) {
  try {
    return JSON.parse(body).idempotencyKey ?? null;
  } catch {
    return null;
  }
}

async function fileExists(file) {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function closeServer(httpServer) {
  httpServer.close();
  httpServer.closeAllConnections?.();
}

function debug(message) {
  if (process.env.PROOF_DEBUG === "1") console.error(`[proof-debug] ${message}`);
}
